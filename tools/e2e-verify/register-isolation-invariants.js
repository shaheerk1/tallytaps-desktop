/**
 * Registers and documents belong to the location that raised them.
 *
 * Runs inside one real transaction against the real schema and rolls back.
 *
 * The cheque register, the bank accounts, the bills, the GRNs and the supplier
 * sales statements are all reached by a record id, and an id carries no
 * location for the IPC gate to bind. Each query therefore has to check the
 * location itself. When they did not, a workstation at one location listed,
 * opened and changed another location's records.
 *
 * Two locations are set up, RA and RB, as if they were two shops of one owner.
 * RA owns everything; RB must see and touch none of it, while RA keeps working.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createInventoryLedgerRepository } = require('../../packages/database/repositories/inventory-ledger.repository');
const { createPartyRepository } = require('../../packages/database/repositories/party.repository');
const { createIssuedChequeRepository } = require('../../packages/database/repositories/issued-cheque.repository');
const { createCatalogRepository } = require('../../packages/database/repositories/catalog.repository');
const { createBillingRepository } = require('../../packages/database/repositories/billing.repository');
const { createSupplierSaleStatementRepository } = require('../../packages/database/repositories/supplier-sale-statement.repository');
const requestContext = require('../../packages/core/security/request-context');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejection(work, pattern, label) {
  let message = null;
  try { await work(); } catch (error) { message = error.message; }
  if (message === null) throw new Error(`${label} was accepted but should have been refused.`);
  if (!pattern.test(message)) throw new Error(`${label} was refused for the wrong reason: ${message}`);
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
        beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}
      };
      const database = { withConnection: async (work) => work(tx) };
      const documentSequenceRepository = createDocumentSequenceRepository({ database });
      const businessDayRepository = createBusinessDayRepository({ database });
      const parties = createPartyRepository({ database, documentSequenceRepository, businessDayRepository });
      const issuedCheques = createIssuedChequeRepository({ database, documentSequenceRepository, businessDayRepository });
      const catalog = createCatalogRepository({ database, documentSequenceRepository, businessDayRepository });
      const billing = createBillingRepository({
        database, documentSequenceRepository, businessDayRepository,
        inventoryLedgerRepository: createInventoryLedgerRepository({ database })
      });
      const statements = createSupplierSaleStatementRepository({ database, documentSequenceRepository, businessDayRepository });

      try {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
        const stamp = String(Date.now()).slice(-8);
        const owner = `RA${stamp}`;
        const other = `RB${stamp}`;
        const txnDate = '2099-12-04';

        const place = async (locCode, macCode) => {
          await connection.execute(
            "INSERT INTO pos_locations (loc_code, business_code, name) VALUES (?, 'VERIFY', ?)", [locCode, `Register ${locCode}`]
          );
          const [ws] = await connection.execute(
            "INSERT INTO pos_workstations (location_code, machine_code, name) VALUES (?, ?, 'Counter')", [locCode, macCode]
          );
          const [day] = await connection.execute(
            "INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [locCode, txnDate, user.id]
          );
          const [session] = await connection.execute(
            'INSERT INTO workstation_sessions (workstation_id, user_id, billing_date) VALUES (?, ?, ?)', [ws.insertId, user.id, txnDate]
          );
          return {
            locCode,
            macCode,
            dayId: Number(day.insertId),
            context: {
              user: { id: user.id },
              workstation: {
                locCode, macCode, businessDate: txnDate,
                workstationId: Number(ws.insertId), workstationSessionId: Number(session.insertId)
              }
            }
          };
        };

        const ra = await place(owner, 'A1');
        const rb = await place(other, 'B1');
        // What each location may see is decided by the session it runs in.
        const asOwner = (work) => requestContext.run(ra.context, work);
        const asOther = (work) => requestContext.run(rb.context, work);

        // ── RA's records ───────────────────────────────────
        const [supplier] = await connection.execute(
          "INSERT INTO suppliers (loc_code, supplier_code, name) VALUES (?, ?, 'Register supplier')",
          [owner, `SUP-${owner}`]
        );
        const [invoice] = await connection.execute(
          `INSERT INTO invoices (business_day_id, invoice_number, loc_code, mac_code, receipt_no, txn_date, user_id,
             status, subtotal, merchandise_total, grand_total, paid_total, balance, inv_stat)
           VALUES (?, ?, ?, 'A1', 1, ?, ?, 'paid', 1000, 1000, 1000, 1000, 0, 'active')`,
          [ra.dayId, `INV-${owner}`, owner, txnDate, user.id]
        );
        const [payment] = await connection.execute(
          `INSERT INTO payments (business_day_id, invoice_id, loc_code, mac_code, txn_date, document_type, document_no,
             receipt_no, payment_no, method, amount, status)
           VALUES (?, ?, ?, 'A1', ?, 'sale', 1, 1, 1, 'cheque', 1000, 'completed')`,
          [ra.dayId, invoice.insertId, owner, txnDate]
        );
        const [cheque] = await connection.execute(
          `INSERT INTO cheques (payment_id, invoice_id, loc_code, mac_code, txn_date, document_type, document_no,
             payment_no, amount, cheque_number, bank_name, status)
           VALUES (?, ?, ?, 'A1', ?, 'sale', 1, 1, 1000, 'CHQ-1', 'Verify Bank', 'received')`,
          [payment.insertId, invoice.insertId, owner, txnDate]
        );
        const [fund] = await connection.execute(
          "INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code) VALUES (?, 'Register bank', 'bank', ?)",
          [`FUND-${owner}`, owner]
        );
        const [bankAccount] = await connection.execute(
          `INSERT INTO business_bank_accounts (loc_code, mac_code, account_no, fund_account_id, account_code,
             bank_name, account_name, account_number)
           VALUES (?, 'A1', 1, ?, ?, 'Verify Bank', 'Register account', '0001')`,
          [owner, fund.insertId, `BA-${owner}`]
        );
        const [grn] = await connection.execute(
          `INSERT INTO goods_receipts (business_day_id, grn_number, loc_code, mac_code, grn_no, supplier_id, business_date)
           VALUES (?, ?, ?, 'A1', 1, ?, ?)`,
          [ra.dayId, `GRN-${owner}`, owner, supplier.insertId, txnDate]
        );
        const [statement] = await connection.execute(
          `INSERT INTO supplier_sale_statements (business_day_id, statement_number, loc_code, mac_code, txn_date,
             statement_no, supplier_id, from_date, to_date)
           VALUES (?, ?, ?, 'A1', ?, 1, ?, ?, ?)`,
          [ra.dayId, `PAT-${owner}`, owner, txnDate, supplier.insertId, txnDate, txnDate]
        );

        // A catalog item and a sold line at each location, so a list that
        // forgets the location shows the other side's rows.
        const stockItem = async (place, sku) => {
          const [product] = await connection.execute(
            'INSERT INTO products (loc_code, sku, name, is_active) VALUES (?, ?, ?, 1)', [place.locCode, sku, `Item ${sku}`]
          );
          await connection.execute(
            'INSERT INTO inventory_balances (loc_code, product_id, handling_on_hand) VALUES (?, ?, 5)',
            [place.locCode, product.insertId]
          );
          return Number(product.insertId);
        };
        await stockItem(ra, `SKU-${owner}`);
        await stockItem(rb, `SKU-${other}`);
        const [soldLine] = await connection.execute(
          `INSERT INTO invoice_items (business_day_id, invoice_id, loc_code, mac_code, receipt_no, txn_date, user_id, seq_no,
             item_code, description, quantity, unit_price, merchandise_total, total, pricing_basis, inv_stat)
           VALUES (?, ?, ?, 'A1', 1, ?, ?, 1, 'VRI', 'Register goods', 1, 1000, 1000, 1000, 'qty', 'active')`,
          [ra.dayId, invoice.insertId, owner, txnDate, user.id]
        );

        const chequeId = Number(cheque.insertId);
        const invoiceId = Number(invoice.insertId);

        // ── 1. The cheque register ─────────────────────────
        assert((await asOwner(() => parties.listCheques({}))).length === 1, 'The location that took the cheque in must see it.');
        assert((await asOther(() => parties.listCheques({}))).length === 0, 'Another location must not see the cheque register.');
        assert(await asOwner(() => parties.getCheque(chequeId)), 'The owning location must be able to open its own cheque.');
        assert(await asOther(() => parties.getCheque(chequeId)) === null, 'Another location must not open the cheque by its id.');
        passed.push('the cheque register is listed and opened only at the location that took the cheque in');

        // ── 2. Changing someone else's cheque ──────────────
        for (const [label, work] of [
          ['editing the cheque details', () => parties.updateChequeDetails({ chequeId, details: { bankName: 'Moved' }, userId: user.id })],
          ['moving the cheque status', () => parties.updateChequeStatus({ chequeId, status: 'deposited', depositedFundAccountId: fund.insertId, userId: user.id })],
          ['relinking the cheque', () => parties.linkCheque({ chequeId, drawerPartyId: null, userId: user.id })]
        ]) {
          await expectRejection(() => asOther(work), /belongs to another location/i, `${label} from another location`);
        }
        passed.push('another location cannot edit, bank, or relink a cheque it did not take in');

        // ── 3. Business bank accounts ──────────────────────
        assert((await asOwner(() => issuedCheques.listBankAccounts(true))).length === 1, 'A location must see its own bank account.');
        assert((await asOther(() => issuedCheques.listBankAccounts(true))).length === 0, 'Another location must not see the bank accounts.');
        await expectRejection(
          () => asOther(() => issuedCheques.saveBankAccount({
            id: Number(bankAccount.insertId), bankName: 'Moved', accountName: 'Moved', accountNumber: '9999', userId: user.id
          })),
          /belongs to another location/i, 'editing another location’s bank account'
        );
        passed.push('business bank accounts are listed and edited only by the location that banks with them');

        // ── 4. Bills ───────────────────────────────────────
        assert(await asOwner(() => billing.getInvoiceArchive(invoiceId)), 'A bill must open at the location that raised it.');
        await expectRejection(
          () => asOther(() => billing.getInvoiceArchive(invoiceId)),
          /belongs to another location/i, 'opening another location’s bill'
        );
        assert((await asOwner(() => billing.searchInvoices({}))).some((row) => Number(row.id) === invoiceId),
          'A bill search must find the location’s own bills.');
        assert(!(await asOther(() => billing.searchInvoices({}))).some((row) => Number(row.id) === invoiceId),
          'A bill search must never reach into another location.');
        passed.push('a bill is searched and opened only at the location that raised it');

        // ── 5. GRNs and supplier sales statements ──────────
        assert(await asOwner(() => catalog.getGoodsReceipt(Number(grn.insertId))), 'A GRN must open at its own location.');
        await expectRejection(
          () => asOther(() => catalog.getGoodsReceipt(Number(grn.insertId))),
          /does not belong to this location/i, 'opening another location’s GRN'
        );
        assert(await asOwner(() => statements.getStatement(Number(statement.insertId))), 'A statement must open at its own location.');
        assert(await asOther(() => statements.getStatement(Number(statement.insertId))) === null,
          'Another location must not open a supplier sales statement.');
        await expectRejection(
          () => asOther(() => statements.voidStatement(Number(statement.insertId), user.id, 'Verify void attempt')),
          /belongs to another location/i, 'voiding another location’s statement'
        );
        passed.push('GRNs and supplier sales statements are opened and voided only at their own location');

        // ── 6. Building a supplier sales statement ─────────
        const ownCandidates = (await asOwner(() => statements.listCandidates({}))).rows;
        assert(ownCandidates.some((row) => Number(row.invoiceItemId) === Number(soldLine.insertId)),
          'The statement builder must offer the location’s own sale lines.');
        const otherCandidates = (await asOther(() => statements.listCandidates({}))).rows;
        assert(!otherCandidates.some((row) => Number(row.invoiceItemId) === Number(soldLine.insertId)),
          'The statement builder must never offer another location’s sale lines.');
        await expectRejection(
          () => asOther(() => statements.setInvoiceItemAttribution({
            invoiceItemId: Number(soldLine.insertId), supplierId: Number(supplier.insertId), reason: 'Verify attempt', userId: user.id
          })),
          /belongs to another location/i, 'reattributing another location’s sale line'
        );
        passed.push('a supplier sales statement is built from, and re-attributes, only its own location’s sales');

        // ── 7. Stock on hand ───────────────────────────────
        const ownStock = await asOwner(() => catalog.listInventorySummary(owner));
        const otherStock = await asOther(() => catalog.listInventorySummary(other));
        assert(ownStock.length === 1 && ownStock[0].sku === `SKU-${owner}`,
          `Stock on hand must list this location’s own item, got ${ownStock.map((r) => r.sku).join(',')}.`);
        assert(otherStock.length === 1 && otherStock[0].sku === `SKU-${other}`,
          `Stock on hand must not list another location’s items, got ${otherStock.map((r) => r.sku).join(',')}.`);
        passed.push('stock on hand lists only the items in this location’s own catalog');

        console.log('Register isolation invariants passed:');
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

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
