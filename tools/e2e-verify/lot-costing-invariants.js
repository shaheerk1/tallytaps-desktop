/**
 * Phase 2 exit checks: allocation and landed cost.
 *
 * Runs inside one real transaction against the real schema and rolls back, so
 * it is safe against a live database.
 *
 *   1. one bill split across a three-lot delivery by kilograms sums back to the
 *      original total to the cent;
 *   2. recomputing the landed-cost projections from source records changes
 *      nothing;
 *   3. a consignment lot never shows a purchase cost;
 *   4. moving a cost between lots leaves both lots' history intact;
 *   5. attaching more than the expense is worth is refused;
 *   6. landed cost per bag and per kilo is the real cost of the goods;
 *   7. every allocation posts a balanced journal entry.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createJournalRepository } = require('../../packages/database/repositories/journal.repository');
const { createExpenseRepository } = require('../../packages/database/repositories/expense.repository');
const { createLotCostingRepository } = require('../../packages/database/repositories/lot-costing.repository');
const { createExpenseService } = require('../../packages/core/expenses/expense.service');
const { createLotCostingService } = require('../../packages/core/lot-costing/lot-costing.service');

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejection(promise, label) {
  try { await promise; } catch (error) { return error.message; }
  throw new Error(`${label} was accepted but should have been refused.`);
}

async function main() {
  const realDatabase = createDatabase();
  try {
    await realDatabase.withConnection(async (connection) => {
      await connection.beginTransaction();
      const txConnection = {
        execute: (...args) => connection.execute(...args),
        query: (...args) => connection.query(...args),
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {}
      };
      const database = { withConnection: async (work) => work(txConnection) };
      const documentSequenceRepository = createDocumentSequenceRepository({ database });
      const businessDayRepository = createBusinessDayRepository({ database });
      const journalRepository = createJournalRepository({ database, documentSequenceRepository });
      const expenseRepository = createExpenseRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository });
      const lotCostingRepository = createLotCostingRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository });
      const expenses = createExpenseService({ expenseRepository });
      const costing = createLotCostingService({ lotCostingRepository });

      try {
        const [[user]] = await connection.execute('SELECT id FROM users WHERE status = ? ORDER BY id LIMIT 1', ['active']);
        assert(user, 'Lot costing invariants require an active user.');

        const stamp = String(Date.now()).slice(-8);
        const locCode = `LC${stamp}`.slice(0, 30);
        const macCode = 'T1';
        const txnDate = '2099-04-01';
        const origin = { locCode, macCode, txnDate };
        const base = { userId: user.id, origin };

        // Every workstation belongs to a registered location.
        await connection.execute(
          'INSERT INTO pos_locations (loc_code, business_code, name) VALUES (?, ?, ?)', [locCode, 'VERIFY', 'Verification location']
        );
        // Items belong to one location's catalog; these are this test's own.
        const products = [];
        for (let i = 1; i <= 3; i += 1) {
          const [item] = await connection.execute(
            'INSERT INTO products (loc_code, sku, name, unit_price) VALUES (?, ?, ?, 0)', [locCode, `LC-ITEM-${i}`, `Lot costing item ${i}`]
          );
          products.push({ id: item.insertId });
        }
        const [ws] = await connection.execute(
          'INSERT INTO pos_workstations (location_code, machine_code, name) VALUES (?, ?, ?)',
          [locCode, macCode, 'Lot costing terminal']
        );
        const [day] = await connection.execute(
          `INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)`,
          [locCode, txnDate, user.id]
        );
        const [supplier] = await connection.execute(
          'INSERT INTO suppliers (loc_code, supplier_code, name) VALUES (?, ?, ?)', [locCode, `SUP-${stamp}`, 'Invariant Farms']
        );
        const [safeFund] = await connection.execute(
          `INSERT INTO fund_accounts (fund_code, name, fund_kind, loc_code, opening_balance)
           VALUES (?, 'Costing safe', 'cash_safe', ?, 500000)`, [`SAFE-${locCode}`, locCode]
        );
        const [[lotCategory]] = await connection.execute(
          `SELECT id, name FROM expense_categories WHERE default_treatment = 'lot_cost' AND is_active = 1 ORDER BY sort_order LIMIT 1`
        );

        // One delivery, three lots at 100 / 200 / 300 kg.
        const [grn] = await connection.execute(
          `INSERT INTO goods_receipts
             (business_day_id, grn_number, loc_code, mac_code, grn_no, document_type, supplier_id, business_date, status, created_by)
           VALUES (?, ?, ?, ?, 1, 'receipt', ?, ?, 'finalized', ?)`,
          [day.insertId, `GRN-${locCode}-1`, locCode, macCode, supplier.insertId, txnDate, user.id]
        );
        const kilos = [100, 200, 300];
        const bags = [10, 20, 30];
        const lotIds = [];
        for (let i = 0; i < kilos.length; i += 1) {
          const productId = products[i % products.length].id;
          const [line] = await connection.execute(
            `INSERT INTO goods_receipt_lines
               (goods_receipt_id, loc_code, mac_code, business_date, grn_no, line_no, product_id,
                package_qty, handling_quantity, received_kilos, received_base_quantity, conversion_mode, ratio_tolerance_percent, unit_cost)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'variable', 20, ?)`,
            [grn.insertId, locCode, macCode, txnDate, i + 1, productId, bags[i], bags[i], kilos[i], kilos[i], 50]
          );
          const [lot] = await connection.execute(
            `INSERT INTO inventory_lots
               (goods_receipt_line_id, lot_code, loc_code, mac_code, txn_date, grn_no, line_no,
                supplier_id, product_id, ownership_model, received_quantity, received_handling_quantity,
                remaining_quantity, remaining_handling_quantity, received_kilos, received_base_quantity,
                remaining_kilos, remaining_base_quantity, handling_uom_snapshot, base_uom_snapshot,
                conversion_mode, ratio_tolerance_percent, terms_snapshot)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'owned', ?, ?, ?, ?, ?, ?, ?, ?, 'bag', 'kg', 'variable', 20, CAST('{}' AS JSON))`,
            [line.insertId, `LOT-${locCode}-${i + 1}`, locCode, macCode, txnDate, i + 1,
              supplier.insertId, productId, bags[i], bags[i], bags[i], bags[i], kilos[i], kilos[i], kilos[i], kilos[i]]
          );
          lotIds.push(Number(lot.insertId));
          // The purchase side the GRN would have written for owned stock.
          await connection.execute(
            `INSERT INTO supplier_payable_entries
               (supplier_id, loc_code, mac_code, goods_receipt_id, inventory_lot_id, entry_type, amount, business_date,
                document_type, document_no, line_no, entry_no, reason, created_by)
             VALUES (?, ?, ?, ?, ?, 'purchase_debit', ?, ?, 'grn', 1, ?, ?, 'Owned stock received', ?)`,
            [supplier.insertId, locCode, macCode, grn.insertId, lot.insertId, kilos[i] * 50, txnDate, i + 1, i + 1, user.id]
          );
        }
        await lotCostingRepository.recomputeLotCostsWithConnection(txConnection, lotIds);

        // ── 1. A split sums back to the whole ───────────────
        const lorryBill = await expenses.recordExpense({ attachLater: true,
          ...base, expenseCategoryId: lotCategory.id, fundAccountId: safeFund.insertId,
          amount: 100, reason: 'Lorry wage for the whole delivery'
        });
        const spread = await costing.allocateExpense({
          ...base, expenseEntryId: lorryBill.id, goodsReceiptId: grn.insertId, basis: 'base_quantity'
        });
        const shares = spread.allocations.map((row) => row.amount);
        assert(shares.length === 3, `Expected 3 shares, got ${shares.length}.`);
        assert(money(shares.reduce((sum, value) => sum + value, 0)) === 100,
          `Split must sum to 100.00, got ${money(shares.reduce((sum, value) => sum + value, 0))}.`);
        assert(money(shares[0]) === 16.67 && money(shares[1]) === 33.33 && money(shares[2]) === 50,
          `Expected 16.67 / 33.33 / 50.00 by kilograms, got ${shares.join(' / ')}.`);
        assert(money(spread.unallocatedTotal) === 0, 'The whole bill should be attached.');

        // ── 6. Landed cost per bag and per kilo ─────────────
        let report = await costing.getProfitability({ locCode });
        const lotOne = report.lots.find((row) => row.id === lotIds[0]);
        // 100 kg at 50.00 = 5000.00 purchase, plus 16.67 lorry share.
        assert(money(lotOne.purchaseCost) === 5000, `Lot 1 purchase cost should be 5000.00, got ${lotOne.purchaseCost}.`);
        assert(money(lotOne.allocatedCost) === 16.67, `Lot 1 attached cost should be 16.67, got ${lotOne.allocatedCost}.`);
        assert(money(lotOne.landedCostTotal) === 5016.67, `Lot 1 landed cost should be 5016.67, got ${lotOne.landedCostTotal}.`);
        assert(money(lotOne.landedCostPerHandling) === 501.67, `Lot 1 cost per bag should be 501.67, got ${lotOne.landedCostPerHandling}.`);
        assert(money(lotOne.landedCostPerBase) === 50.17, `Lot 1 cost per kg should be 50.17, got ${lotOne.landedCostPerBase}.`);

        // ── 2. Projections rebuild to the same numbers ──────
        let drift = await costing.reconcile({ locCode });
        assert(drift.drifted === 0, `Landed cost projections drifted on ${drift.drifted} lot(s).`);
        await connection.execute('UPDATE inventory_lots SET landed_cost_total = 0 WHERE id = ?', [lotIds[0]]);
        drift = await costing.reconcile({ locCode });
        assert(drift.drifted === 1, 'Reconciliation should notice a projection that no longer matches its ledger.');
        await lotCostingRepository.recomputeLotCostsWithConnection(txConnection, lotIds);
        drift = await costing.reconcile({ locCode });
        assert(drift.drifted === 0, 'Recomputing from source records should clear the drift.');

        // ── 5. Over-attaching is refused ────────────────────
        const overAllocated = await expectRejection(costing.allocateExpense({
          ...base, expenseEntryId: lorryBill.id, inventoryLotId: lotIds[0], basis: 'direct', amount: 1
        }), 'Attaching more than the expense is worth');
        assert(/nothing left|still unattached/i.test(overAllocated), `Unexpected refusal: ${overAllocated}`);

        // ── 4. Moving a cost keeps both histories ───────────
        const moved = await costing.reallocate({
          ...base, expenseEntryId: lorryBill.id,
          fromInventoryLotId: lotIds[0], toInventoryLotId: lotIds[2],
          amount: 10, reason: 'Those bags actually travelled with the third lot'
        });
        assert(moved.reallocationNumber.startsWith(`ERA-${locCode}`), 'The reallocation should carry an origin-stamped number.');
        report = await costing.getProfitability({ locCode });
        const movedFrom = report.lots.find((row) => row.id === lotIds[0]);
        const movedTo = report.lots.find((row) => row.id === lotIds[2]);
        assert(money(movedFrom.allocatedCost) === 6.67, `Lot 1 should keep 6.67 after the move, got ${movedFrom.allocatedCost}.`);
        assert(money(movedTo.allocatedCost) === 60, `Lot 3 should hold 60.00 after the move, got ${movedTo.allocatedCost}.`);

        const detail = await costing.getLotCostDetail({ inventoryLotId: lotIds[0], locCode });
        assert(detail.allocations.length === 2, `Lot 1 should show both the original share and the move, got ${detail.allocations.length}.`);
        assert(detail.allocations.some((row) => row.amount === -10 && row.documentType === 'reallocation'),
          'The lot that gave the cost up should show a negative reallocation row.');
        assert(detail.allocations.some((row) => money(row.amount) === 16.67 && row.documentType === 'expense'),
          'The original share must still be visible; a move never edits it.');

        // The whole bill is still attached somewhere.
        const attached = money(report.lots.reduce((sum, row) => sum + row.allocatedCost, 0));
        assert(attached === 100, `The whole 100.00 should still be attached across the lots, got ${attached}.`);

        // ── 3. A consignment lot has no purchase cost ───────
        const [consignLine] = await connection.execute(
          `INSERT INTO goods_receipt_lines
             (goods_receipt_id, loc_code, mac_code, business_date, grn_no, line_no, product_id,
              package_qty, handling_quantity, received_kilos, received_base_quantity, conversion_mode, ratio_tolerance_percent)
           VALUES (?, ?, ?, ?, 1, 4, ?, 5, 5, 50, 50, 'variable', 20)`,
          [grn.insertId, locCode, macCode, txnDate, products[0].id]
        );
        const [consignLot] = await connection.execute(
          `INSERT INTO inventory_lots
             (goods_receipt_line_id, lot_code, loc_code, mac_code, txn_date, grn_no, line_no,
              supplier_id, product_id, ownership_model, received_quantity, received_handling_quantity,
              remaining_quantity, remaining_handling_quantity, received_kilos, received_base_quantity,
              remaining_kilos, remaining_base_quantity, handling_uom_snapshot, base_uom_snapshot,
              conversion_mode, ratio_tolerance_percent, terms_snapshot)
           VALUES (?, ?, ?, ?, ?, 1, 4, ?, ?, 'consignment', 5, 5, 0, 0, 50, 50, 0, 0, 'bag', 'kg', 'variable', 20, CAST('{}' AS JSON))`,
          [consignLine.insertId, `LOT-${locCode}-C`, locCode, macCode, txnDate, supplier.insertId, products[0].id]
        );
        // Sold for 9,000 with 8,000 accrued to the supplier.
        await connection.execute(
          `INSERT INTO lot_sale_allocations
             (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, allocation_no,
              quantity, handling_quantity, kilos, base_quantity, sale_value)
           VALUES (?, ?, ?, ?, 'sale', 1, 1, 1, 5, 5, 50, 50, 9000)`,
          [consignLot.insertId, locCode, macCode, txnDate]
        );
        await connection.execute(
          `INSERT INTO supplier_payable_entries
             (supplier_id, loc_code, mac_code, goods_receipt_id, inventory_lot_id, entry_type, amount, business_date,
              document_type, document_no, line_no, entry_no, reason, created_by)
           VALUES (?, ?, ?, ?, ?, 'consignment_accrual', 8000, ?, 'sale', 1, 1, 99, 'Consignment sale accrual', ?)`,
          [supplier.insertId, locCode, macCode, grn.insertId, consignLot.insertId, txnDate, user.id]
        );
        const unloading = await expenses.recordExpense({ attachLater: true,
          ...base, expenseCategoryId: lotCategory.id, fundAccountId: safeFund.insertId,
          amount: 250, reason: 'Unloading the consignment bags'
        });
        await costing.allocateExpense({
          ...base, expenseEntryId: unloading.id, inventoryLotId: Number(consignLot.insertId), basis: 'direct'
        });

        report = await costing.getProfitability({ locCode });
        const consign = report.lots.find((row) => row.id === Number(consignLot.insertId));
        assert(consign.ownershipModel === 'consignment', 'The consignment lot should be reported as consignment.');
        assert(money(consign.purchaseCost) === 0, `A consignment lot must never carry a purchase cost, got ${consign.purchaseCost}.`);
        assert(money(consign.supplierDue) === 8000, `Supplier due should be 8000.00, got ${consign.supplierDue}.`);
        // 9000 sold - 8000 owed to the farmer - 250 unloading = 750 earned.
        assert(money(consign.margin) === 750, `Consignment earning should be 750.00, got ${consign.margin}.`);

        // ── 7. Every allocation posted a balanced entry ─────
        const trial = await journalRepository.getTrialBalance({ locCode });
        assert(trial.inBalance, `The journal is out of balance by ${trial.difference}.`);
        const [[allocationPostings]] = await connection.execute(
          `SELECT COUNT(*) AS n FROM journal_entries WHERE loc_code = ? AND source_type = 'expense_allocation'`, [locCode]
        );
        // 3 shares + 2 reallocation sides + 1 consignment allocation = 6.
        assert(Number(allocationPostings.n) === 6, `Expected 6 allocation postings, got ${allocationPostings.n}.`);

        console.log('Lot costing invariants passed:');
        console.log('  1. one bill split across three lots by kilograms sums back to the cent (16.67 + 33.33 + 50.00)');
        console.log('  2. recomputing landed cost from source records changes nothing, and drift is detected');
        console.log('  3. a consignment lot carries no purchase cost and earns 9000 - 8000 - 250 = 750.00');
        console.log('  4. moving a cost between lots leaves both histories intact and the total still attached');
        console.log('  5. attaching more than the expense is worth is refused');
        console.log('  6. landed cost per bag (501.67) and per kilo (50.17) is the real cost of the goods');
        console.log('  7. every allocation posted a balanced journal entry');
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
