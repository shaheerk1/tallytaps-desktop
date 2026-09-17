/**
 * Workstation and location isolation, end to end.
 *
 * Proves the contract in docs/features/location-identity-and-workstation-isolation-plan.md
 * against the real schema, the real repositories and services, the real IPC
 * gate, and the real request context. Everything runs in one transaction that is
 * rolled back, so it is safe against a live database.
 *
 * Two locations are set up, VA and VB, as if they were two businesses of one
 * owner on one machine.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createJournalRepository } = require('../../packages/database/repositories/journal.repository');
const { createExpenseRepository } = require('../../packages/database/repositories/expense.repository');
const { createWorkstationRepository } = require('../../packages/database/repositories/workstation.repository');
const { createAuthRepository } = require('../../packages/database/repositories/auth.repository');
const { createCatalogRepository } = require('../../packages/database/repositories/catalog.repository');
const { createPartyRepository } = require('../../packages/database/repositories/party.repository');
const { createSettingsRepository } = require('../../packages/database/repositories/settings.repository');
const { createInventoryLedgerRepository } = require('../../packages/database/repositories/inventory-ledger.repository');
const { createExpenseService } = require('../../packages/core/expenses/expense.service');
const { createWorkstationService } = require('../../packages/core/workstations/workstation.service');
const { createSettingsService } = require('../../packages/core/settings/settings.service');
const { createReportService } = require('../../packages/core/reports/report.service');
const { createSessionContextService } = require('../../packages/core/security/session-context.service');
const requestContext = require('../../packages/core/security/request-context');
const { bindIdentity } = require('../../apps/desktop/electron/ipc/ipc-response');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejection(promise, pattern, label) {
  let message = null;
  try { await promise; } catch (error) { message = error.message; }
  if (message === null) throw new Error(`${label} was accepted but should have been refused.`);
  if (pattern && !pattern.test(message)) throw new Error(`${label} was refused for the wrong reason: ${message}`);
  return message;
}

async function main() {
  const realDatabase = createDatabase();
  const passed = [];
  try {
    await realDatabase.withConnection(async (connection) => {
      await connection.beginTransaction();
      const tx = {
        execute: (...args) => connection.execute(...args),
        query: (...args) => connection.query(...args),
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {}
      };
      const database = { withConnection: async (work) => work(tx) };
      const documentSequenceRepository = createDocumentSequenceRepository({ database });
      const businessDayRepository = createBusinessDayRepository({ database });
      const journalRepository = createJournalRepository({ database, documentSequenceRepository });
      const expenseRepository = createExpenseRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository });
      const workstationRepository = createWorkstationRepository({ database, businessDayRepository });
      const authRepository = createAuthRepository({ database });
      const inventoryLedgerRepository = createInventoryLedgerRepository({ database });
      const catalogRepository = createCatalogRepository({ database, documentSequenceRepository, businessDayRepository, inventoryLedgerRepository });
      const partyRepository = createPartyRepository({ database, businessDayRepository });
      const settingsRepository = createSettingsRepository({ database });
      const settingsService = createSettingsService({ settingsRepository });
      const expenseService = createExpenseService({ expenseRepository });
      const workstationService = createWorkstationService({ workstationRepository, settingsRepository });
      const reportService = createReportService({ database });
      const sessions = createSessionContextService({ authRepository });

      try {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
        assert(user, 'Isolation invariants require an active user.');
        const [openNow] = await connection.execute("SELECT id FROM workstation_sessions WHERE user_id = ? AND status = 'open'", [user.id]);
        // Close any real open sessions inside this transaction so the test starts clean.
        if (openNow.length) await connection.query("UPDATE workstation_sessions SET status = 'closed' WHERE id IN (?)", [openNow.map((row) => row.id)]);

        const stamp = String(Date.now()).slice(-7);
        const VA = `VA${stamp}`;
        const VB = `VB${stamp}`;
        const date = '2099-06-01';

        // ── Setup: two locations, one workstation each ─────
        await workstationService.createLocation({ locCode: VA, businessCode: 'KHANSTORE', name: 'Khan Store' });
        await workstationService.createLocation({ locCode: VB, businessCode: 'KHANRETAIL', name: 'Khan Retail' });
        const wsA = await workstationService.createWorkstation({ locationCode: VA, machineCode: 'T1', name: 'Store counter' });
        const wsB = await workstationService.createWorkstation({ locationCode: VB, machineCode: 'T1', name: 'Retail counter' });
        const days = {};
        for (const loc of [VA, VB]) {
          const [day] = await connection.execute(
            "INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [loc, date, user.id]
          );
          days[loc] = day.insertId;
        }

        // ── 1. Login honours the chosen workstation ───────
        const onA = await workstationRepository.openSession({ workstationId: wsA.id, userId: user.id, billingDate: date });
        assert(Number(onA.workstationId) === Number(wsA.id), 'Signing in to A must open a session on A.');
        const onB = await workstationRepository.openSession({ workstationId: wsB.id, userId: user.id, billingDate: date });
        assert(Number(onB.workstationId) === Number(wsB.id), 'Choosing B must land on B, never back on A.');
        assert(onB.closedElsewhere.includes('Store counter'), 'The earlier session on A must be reported as closed.');
        const [[aState]] = await connection.execute('SELECT status FROM workstation_sessions WHERE id = ?', [onA.id]);
        assert(aState.status === 'closed', 'The session on A must be closed when the user moves to B.');
        const resumed = await workstationRepository.openSession({ workstationId: wsB.id, userId: user.id, billingDate: date });
        assert(Number(resumed.id) === Number(onB.id), 'Signing in to B again must resume the same session.');
        passed.push('choosing workstation B lands on B, closes A, and signing in to B again resumes it');

        // ── 2. An open cash shift elsewhere refuses the move ─
        const [drawer] = await connection.execute('INSERT INTO cash_drawers (workstation_id, name) VALUES (?, ?)', [wsB.id, 'Retail drawer']);
        await connection.execute(
          `INSERT INTO cash_shifts (business_day_id, drawer_id, workstation_session_id, workstation_id, user_id,
             loc_code, mac_code, shift_no, business_date, status, opening_total)
           VALUES (?, ?, ?, ?, ?, ?, 'T1', 1, ?, 'open', 0)`,
          [days[VB], drawer.insertId, onB.id, wsB.id, user.id, VB, date]
        );
        let refusal = null;
        try { await workstationRepository.openSession({ workstationId: wsA.id, userId: user.id, billingDate: date }); } catch (error) { refusal = error; }
        assert(refusal && refusal.code === 'SHIFT_OPEN_ON_ANOTHER_WORKSTATION', 'An open shift on B must refuse signing in to A.');
        assert(/Retail counter/.test(refusal.message), `The refusal must name where the shift is open: ${refusal?.message}`);
        const [[stillB]] = await connection.execute('SELECT status FROM workstation_sessions WHERE id = ?', [onB.id]);
        assert(stillB.status === 'open', 'A refused move must leave the session with the open shift untouched.');
        await connection.execute("UPDATE cash_shifts SET status = 'closed' WHERE workstation_session_id = ?", [onB.id]);
        passed.push('a cash shift still open on another workstation refuses the sign-in and names where it is');

        // ── 3. The token decides who and where ─────────────
        const tokenB = `verify-${stamp}-b`;
        await authRepository.createSession(user.id, tokenB, '2037-12-31 00:00:00');
        await authRepository.bindWorkstationSession(tokenB, onB.id);
        const ctxB = await sessions.resolve(tokenB);
        assert(ctxB.workstation && ctxB.workstation.locCode === VB, 'The token must resolve to the workstation it is bound to.');
        const realPermissions = await authRepository.getUserPermissions(user.id);
        const spoofed = bindIdentity('expenses.create', {
          actor: { id: '999', permissions: ['everything.admin'] },
          expense: { userId: 999, origin: { locCode: VA, macCode: 'T9', txnDate: '2000-01-01' }, nested: { locCode: VA, sessionId: 1, workstationId: 1 } },
          filters: { locCode: VA, macCode: 'T9', txnDate: '2000-01-01' }
        }, ctxB);
        assert(spoofed.actor.id === String(user.id), 'The actor must be the signed-in user, not the one the screen named.');
        assert(!spoofed.actor.permissions.includes('everything.admin'), 'A permission the screen invented must be dropped.');
        assert(spoofed.actor.permissions.length === realPermissions.length, 'The permissions must be the user’s real ones from the database.');
        assert(spoofed.expense.userId === user.id, 'userId must be the signed-in user.');
        assert(spoofed.expense.origin.locCode === VB && spoofed.expense.origin.txnDate === date, 'origin must be the session’s location and business date.');
        assert(spoofed.expense.nested.locCode === VB, 'A nested location must be overwritten too.');
        assert(spoofed.expense.nested.sessionId === ctxB.workstation.workstationSessionId, 'sessionId must be the session’s own.');
        assert(spoofed.expense.nested.workstationId === ctxB.workstation.workstationId, 'workstationId must be the session’s own.');
        assert(spoofed.filters.locCode === VB, 'A read may only ask for the session’s own location.');
        assert(spoofed.filters.macCode === 'T9' && spoofed.filters.txnDate === '2000-01-01',
          'Terminal and date stay as search filters (another terminal, a past date).');
        const editingUser = bindIdentity('users.setRoles', { userId: 4242 }, ctxB);
        assert(editingUser.userId === 4242, 'On users.* channels userId names the user being edited and must not be replaced.');
        const noWorkstation = bindIdentity('expenses.list', { filters: { locCode: VA } }, { ...ctxB, workstation: null });
        assert(noWorkstation.filters.locCode === null, 'Without a workstation, a location the screen sent must be cleared, not trusted.');
        passed.push('the gate replaces the actor and every identity field with the session’s own, keeping filters');

        // ── 4. A write lands at the session's location ──────
        // An overhead category, because this checks where a write lands, not
        // expense rules: a lot expense (the first by sort order is lorry wage)
        // must now name its GRN and would be refused before the check is reached.
        const [[category]] = await connection.execute("SELECT id FROM expense_categories WHERE loc_code IS NULL AND is_active = 1 AND default_treatment = 'overhead' ORDER BY sort_order LIMIT 1");
        const [safeB] = await connection.execute(
          `INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code, opening_balance) VALUES (?, 'Retail safe', 'cash_safe', ?, 10000)`,
          [`SAFE-${VB}`, VB]
        );
        const expense = await requestContext.run(ctxB, () => expenseService.recordExpense({
          ...spoofed.expense, origin: { locCode: VA, macCode: 'T9', txnDate: '2000-01-01' },
          expenseCategoryId: category.id, fundAccountId: safeB.insertId, amount: 100, reason: 'Isolation check'
        }));
        const [[savedExpense]] = await connection.execute('SELECT loc_code, mac_code, txn_date FROM expense_entries WHERE id = ?', [expense.id]);
        assert(savedExpense.loc_code === VB && savedExpense.mac_code === 'T1',
          `A write inside a request must land at the session's location, got ${savedExpense.loc_code}/${savedExpense.mac_code}.`);
        passed.push('a write with a spoofed origin still lands at the signed-in workstation’s location');

        // ── 5. Location codes are never reused ─────────────
        await expectRejection(workstationService.createLocation({ locCode: VA, businessCode: 'OTHER', name: 'Again' }), /already in use/, 'Re-issuing an active code');
        const [drawerA] = await connection.execute("SELECT id FROM pos_workstations WHERE location_code = ?", [VA]);
        await connection.query("UPDATE pos_workstations SET status = 'inactive' WHERE id IN (?)", [drawerA.map((row) => row.id)]);
        await workstationService.retireLocation(VA);
        await expectRejection(workstationService.createLocation({ locCode: VA, businessCode: 'NEW', name: 'Reused' }), /never reused/, 'Re-issuing a retired code');
        await expectRejection(workstationService.createWorkstation({ locationCode: VA, machineCode: 'T2', name: 'Late' }), /retired/, 'A workstation at a retired location');
        await expectRejection(workstationService.createWorkstation({ locationCode: `ZZ${stamp}`, machineCode: 'T1', name: 'Nowhere' }), /not a registered location/, 'A workstation at an unregistered location');
        await expectRejection(connection.execute('DELETE FROM pos_locations WHERE loc_code = ?', [VA]), /never deleted/, 'Deleting a location');
        await expectRejection(connection.execute('UPDATE pos_locations SET loc_code = ? WHERE loc_code = ?', [`VC${stamp}`, VA]), /cannot be changed/, 'Renaming a location');
        await expectRejection(workstationService.createLocation({ locCode: 'KHANRETAILSHOP_00001X', businessCode: 'K', name: 'Too long' }), /1 to 20 characters/, 'A code too long for a receipt');
        await connection.execute("UPDATE pos_locations SET status = 'active', retired_at = NULL WHERE loc_code = ?", [VA]);
        await connection.query("UPDATE pos_workstations SET status = 'active' WHERE id IN (?)", [drawerA.map((row) => row.id)]);
        passed.push('a location code is never reused, deleted, or renamed, and a retired one takes no workstations');

        // ── 6. Each location owns its catalog ──────────────
        const [itemA] = await connection.execute("INSERT INTO products (loc_code, sku, name, unit_price) VALUES (?, 'ONION', 'Big onion (store price)', 280)", [VA]);
        const [itemB] = await connection.execute("INSERT INTO products (loc_code, sku, name, unit_price) VALUES (?, 'ONION', 'Big onion (retail price)', 320)", [VB]);
        const ctxA = { ...ctxB, workstation: { ...ctxB.workstation, locCode: VA, workstationId: wsA.id } };
        const seenFromA = await requestContext.run(ctxA, () => catalogRepository.searchProducts('ONION'));
        assert(seenFromA.length === 1 && Number(seenFromA[0].id) === Number(itemA.insertId), 'Location A must see only its own ONION.');
        assert(Number(seenFromA[0].unit_price) === 280, 'The same SKU carries each location’s own price.');
        const peek = await requestContext.run(ctxA, () => catalogRepository.getProduct(itemB.insertId));
        assert(peek === null, 'Location A must not read location B’s item by id.');
        await expectRejection(requestContext.run(ctxA, () => catalogRepository.updateProduct(itemB.insertId, { name: 'Hijacked' })),
          /not in this location/, 'Changing another location’s item');
        const created = await requestContext.run(ctxA, () => catalogRepository.createProduct({ sku: 'LEEKS', name: 'Leeks', unitPrice: 150, loc_code: VB, locCode: VB }));
        assert(created.loc_code === VA, 'A new item joins the signed-in location’s catalog, whatever the screen sent.');
        passed.push('each location has its own catalog: same SKU, own price, invisible and unchangeable from elsewhere');

        // ── 7. The database refuses cross-location documents ─
        await expectRejection(connection.execute(
          `INSERT INTO stock_movements (loc_code, mac_code, business_date, document_type, document_no, line_no, event_no, movement_type, product_id, quantity)
           VALUES (?, 'T1', ?, 'adjustment', 1, 1, 1, 'adjustment', ?, 1)`, [VB, date, itemA.insertId]
        ), /not in this location/, 'A stock movement at B for A’s item');
        await expectRejection(connection.execute(
          `INSERT INTO invoice_items (business_day_id, loc_code, mac_code, txn_date, receipt_no, description, product_id)
           VALUES (?, ?, 'T1', ?, 1, 'Onion', ?)`, [days[VB], VB, date, itemA.insertId]
        ), /not in this location/, 'Selling A’s item on a B bill');
        const [supplierA] = await connection.execute("INSERT INTO suppliers (loc_code, supplier_code, name) VALUES (?, 'FARM1', 'Store farm')", [VA]);
        await expectRejection(connection.execute(
          `INSERT INTO goods_receipts (business_day_id, grn_number, loc_code, mac_code, grn_no, document_type, supplier_id, business_date, status)
           VALUES (?, ?, ?, 'T1', 1, 'receipt', ?, ?, 'draft')`, [days[VB], `GRN-${VB}`, VB, supplierA.insertId, date]
        ), /supplier does not belong/, 'Receiving at B from A’s supplier');
        await connection.execute("INSERT INTO suppliers (loc_code, supplier_code, name) VALUES (?, 'FARM1', 'Retail farm')", [VB]);
        passed.push('the database itself refuses A’s item or supplier on B’s bill, stock, or delivery');

        // ── 8. Customers stay with their location ──────────
        const customers = {};
        for (const [loc, name] of [[VA, 'Store buyer'], [VB, 'Retail buyer']]) {
          const [party] = await connection.execute(
            'INSERT INTO parties (loc_code, mac_code, party_no, party_number, display_name) VALUES (?, ?, 1, ?, ?)', [loc, 'T1', `P-${loc}`, name]
          );
          const [account] = await connection.execute(
            'INSERT INTO customer_accounts (loc_code, mac_code, account_no, account_number, party_id) VALUES (?, ?, 1, ?, ?)', [loc, 'T1', `C-${loc}`, party.insertId]
          );
          customers[loc] = account.insertId;
        }
        const buyersAtA = await requestContext.run(ctxA, () => partyRepository.searchCustomerAccounts(''));
        const ids = buyersAtA.map((row) => Number(row.id));
        assert(ids.includes(Number(customers[VA])) && !ids.includes(Number(customers[VB])), 'Location A must see its own customers only.');
        await expectRejection(requestContext.run(ctxA, () => partyRepository.getCustomerAccount(customers[VB])), /another location/, 'Opening B’s customer from A');
        await expectRejection(connection.execute(
          `INSERT INTO invoices (business_day_id, invoice_number, loc_code, mac_code, receipt_no, txn_date, customer_account_id)
           VALUES (?, ?, ?, 'T1', 90, ?, ?)`, [days[VA], `INV-${VA}-90`, VA, date, customers[VB]]
        ), /another location/, 'Billing B’s customer on an A invoice');
        passed.push('a customer is seen, opened, and billed only at the location that owns it');

        // ── 9. Settings: own values, shared fallback ───────
        const sharedName = await settingsService.getSetting('general', 'store_name');
        await requestContext.run(ctxA, () => settingsService.setSetting('general', 'store_name', 'Khan Store'));
        const nameAtA = await requestContext.run(ctxA, () => settingsService.getSetting('general', 'store_name'));
        const nameAtB = await requestContext.run(ctxB, () => settingsService.getSetting('general', 'store_name'));
        const nameShared = await settingsService.getSetting('general', 'store_name');
        assert(nameAtA === 'Khan Store', 'Location A must read its own store name.');
        assert(nameAtB === sharedName && nameShared === sharedName, 'Location B and the shared value must be unaffected by A’s change.');
        const wsSettingsA = await workstationService.getSession(onB.id);
        assert(wsSettingsA && typeof wsSettingsA.workstationSettings === 'object', 'A session returns its location’s workstation settings.');
        passed.push('a location’s own receipt settings win there and never leak to another location');

        // ── 10. Expense categories: shared plus own ────────
        await requestContext.run(ctxA, () => expenseRepository.saveCategory({ name: `Store only ${stamp}`, defaultTreatment: 'overhead' }));
        const catsAtA = await requestContext.run(ctxA, () => expenseRepository.listCategories());
        const catsAtB = await requestContext.run(ctxB, () => expenseRepository.listCategories());
        assert(catsAtA.some((row) => row.name === `Store only ${stamp}`), 'Location A must see its own category.');
        assert(!catsAtB.some((row) => row.name === `Store only ${stamp}`), 'Location B must not see A’s category.');
        assert(catsAtB.some((row) => row.isShared), 'Both locations keep the shared categories.');
        // Editing a shared reason at a location no longer refuses: it gives that
        // location its own copy in the shared one's place. Isolation now means the
        // copy is private, the shared row is untouched, and nobody else sees it.
        const sharedCat = catsAtA.find((row) => row.isShared);
        const renamed = await requestContext.run(ctxA, () => expenseRepository.saveCategory({
          id: sharedCat.id, name: `Renamed ${stamp}`, defaultTreatment: sharedCat.defaultTreatment
        }));
        const [[copyRow]] = await connection.execute('SELECT loc_code, category_code FROM expense_categories WHERE id = ?', [renamed.id]);
        assert(renamed.id !== sharedCat.id && copyRow.loc_code === VA && copyRow.category_code === sharedCat.categoryCode,
          'Editing a shared category at a location must create that location’s own copy, not change the shared row.');
        const [[sharedRow]] = await connection.execute('SELECT loc_code, name FROM expense_categories WHERE id = ?', [sharedCat.id]);
        assert(sharedRow.loc_code === null && sharedRow.name === sharedCat.name, 'The shared category itself must stay unchanged.');
        const catsAtBAfter = await requestContext.run(ctxB, () => expenseRepository.listCategories());
        assert(!catsAtBAfter.some((row) => row.name === `Renamed ${stamp}`), 'Another location must not see a location’s own copy.');
        assert(catsAtBAfter.some((row) => row.id === sharedCat.id && row.name === sharedCat.name), 'Another location keeps the shared original.');
        passed.push('expense categories: every location keeps the shared set, and an edit there becomes its own private copy');

        // ── 11. Reports read one location ──────────────────
        for (const [loc, itemId, code] of [[VA, itemA.insertId, 'STORE-SALE'], [VB, itemB.insertId, 'RETAIL-SALE']]) {
          const [invoice] = await connection.execute(
            `INSERT INTO invoices (business_day_id, invoice_number, loc_code, mac_code, receipt_no, txn_date, status, inv_stat, grand_total)
             VALUES (?, ?, ?, 'T1', 77, ?, 'paid', 'active', 500)`, [days[loc], `INV-${loc}-77`, loc, date]
          );
          await connection.execute(
            `INSERT INTO invoice_items (invoice_id, business_day_id, loc_code, mac_code, txn_date, receipt_no, description, item_code, product_id, total)
             VALUES (?, ?, ?, 'T1', ?, 77, 'Sale', ?, ?, 500)`, [invoice.insertId, days[loc], loc, date, code, itemId]
          );
        }
        const reportA = await requestContext.run(ctxA, () => reportService.salesReport({ fromDate: date, toDate: date, groupBy: 'line' }));
        const codes = reportA.rows.map((row) => row.itemCode);
        assert(codes.includes('STORE-SALE') && !codes.includes('RETAIL-SALE'), `The sales report at A must show only A's sales, got ${codes.join(', ')}.`);
        passed.push('reports read only the signed-in location’s sales');

        console.log('Workstation isolation invariants passed:');
        passed.forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
        console.log('All writes will be rolled back.');
      } finally {
        await connection.rollback();
      }
    });
  } finally {
    await realDatabase.close();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
