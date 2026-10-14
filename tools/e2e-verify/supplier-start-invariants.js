/**
 * A supplier account can be started from the accounts page, exactly once.
 *
 * Runs inside one real transaction against the real schema and rolls back.
 *
 * A supplier used to exist only as a side effect: typing a name on a GRN or on
 * a supplier sales statement created one. Starting it from the accounts page
 * adds a third door into the same table, and the risk that comes with it is a
 * split ledger -- two rows under one name, so the balance reads settled on the
 * one being looked at and owing on the other. All three doors therefore share
 * one matching rule.
 *
 *   1. a new name and code are accepted, and the supplier belongs to this location;
 *   2. a name this location already keeps is refused, whatever the casing, and
 *      the refusal names the account to use instead;
 *   3. a code already taken is refused, including by a retired supplier, whose
 *      code stays reserved because the unique key behind it does not care;
 *   4. the other two doors reuse that supplier rather than adding another;
 *   5. a supplier with no entries yet is hidden from the default list and shown
 *      when the page asks for all of them.
 */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createDocumentSequenceRepository } = require('../../packages/database/repositories/document-sequence.repository');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');
const { createInventoryLedgerRepository } = require('../../packages/database/repositories/inventory-ledger.repository');
const { createJournalRepository } = require('../../packages/database/repositories/journal.repository');
const { createExpenseRepository } = require('../../packages/database/repositories/expense.repository');
const { createCatalogRepository } = require('../../packages/database/repositories/catalog.repository');
const { createSupplierSaleStatementRepository } = require('../../packages/database/repositories/supplier-sale-statement.repository');
const { createSupplierAccountRepository } = require('../../packages/database/repositories/supplier-account.repository');
const requestContext = require('../../packages/core/security/request-context');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejection(work, pattern, label) {
  let message = null;
  try { await work(); } catch (error) { message = error.message; }
  if (message === null) throw new Error(`${label} was accepted but should have been refused.`);
  if (!pattern.test(message)) throw new Error(`${label} was refused for the wrong reason: ${message}`);
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
        beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}
      };
      const database = { withConnection: async (work) => work(tx) };
      const documentSequenceRepository = createDocumentSequenceRepository({ database });
      const businessDayRepository = createBusinessDayRepository({ database });
      const journalRepository = createJournalRepository({ database, documentSequenceRepository });
      const catalog = createCatalogRepository({
        database, documentSequenceRepository, businessDayRepository,
        inventoryLedgerRepository: createInventoryLedgerRepository({ database })
      });
      const statements = createSupplierSaleStatementRepository({ database, documentSequenceRepository, businessDayRepository });
      const accounts = createSupplierAccountRepository({
        database, documentSequenceRepository, businessDayRepository, journalRepository,
        expenseRepository: createExpenseRepository({ database, documentSequenceRepository, businessDayRepository, journalRepository })
      });

      try {
        const [[user]] = await connection.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
        const stamp = String(Date.now()).slice(-8);
        const here = `SA${stamp}`;
        const elsewhere = `SB${stamp}`;
        const txnDate = '2099-12-09';

        const place = async (locCode, macCode) => {
          await connection.execute(
            "INSERT INTO pos_locations (loc_code, business_code, name) VALUES (?, 'VERIFY', ?)", [locCode, `Supplier ${locCode}`]
          );
          const [ws] = await connection.execute(
            "INSERT INTO pos_workstations (location_code, machine_code, name) VALUES (?, ?, 'Counter')", [locCode, macCode]
          );
          await connection.execute(
            "INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [locCode, txnDate, user.id]
          );
          const [session] = await connection.execute(
            'INSERT INTO workstation_sessions (workstation_id, user_id, billing_date) VALUES (?, ?, ?)', [ws.insertId, user.id, txnDate]
          );
          return {
            locCode,
            context: {
              user: { id: user.id },
              workstation: {
                locCode, macCode, businessDate: txnDate,
                workstationId: Number(ws.insertId), workstationSessionId: Number(session.insertId)
              }
            }
          };
        };

        const home = await place(here, 'A1');
        const other = await place(elsewhere, 'B1');
        const at = (place, work) => requestContext.run(place.context, work);

        // ── 1. Starting one ────────────────────────────────
        const started = await at(home, () => catalog.createSupplier({
          name: 'Nimal Produce', supplierCode: 'NIM-1', mobile: '0771234567',
          metadata: { createdFrom: 'supplier_account' }
        }));
        assert(started && Number(started.id) > 0, 'The supplier was not created.');
        assert(started.loc_code === here, `A supplier must belong to the location that started it, got ${started.loc_code}.`);
        assert(started.supplier_code === 'NIM-1' && started.name === 'Nimal Produce', 'The supplier kept the wrong name or code.');
        passed.push('a supplier is started from the accounts page and belongs to that location');

        // ── 2. The same name again ─────────────────────────
        for (const typed of ['Nimal Produce', 'nimal produce', 'NIMAL PRODUCE']) {
          const why = await expectRejection(
            () => at(home, () => catalog.createSupplier({ name: typed })),
            /already a supplier here/i, `starting a second supplier as "${typed}"`
          );
          assert(why.includes('Nimal Produce'), `The refusal must name the account to use instead, got: ${why}`);
        }
        passed.push('a name this location already keeps is refused whatever the casing, and names the account to use');

        // ── 3. A code already taken ────────────────────────
        await expectRejection(
          () => at(home, () => catalog.createSupplier({ name: 'A different name', supplierCode: 'NIM-1' })),
          /already a supplier here/i, 'reusing a live supplier code'
        );
        await connection.execute(
          "INSERT INTO suppliers (loc_code, supplier_code, name, is_active) VALUES (?, 'RETIRED-1', 'Old Mudalali', 0)", [here]
        );
        await expectRejection(
          () => at(home, () => catalog.createSupplier({ name: 'Someone new', supplierCode: 'RETIRED-1' })),
          /belongs to .*retired|retired/i, 'reusing a retired supplier code'
        );
        // The retired supplier's name is free again; only its code is reserved.
        const reborn = await at(home, () => catalog.createSupplier({ name: 'Old Mudalali' }));
        assert(reborn && Number(reborn.id) > 0, 'A retired supplier’s name must be free to use again.');
        passed.push('a code stays taken even once its supplier is retired, while the name comes free');

        // ── 4. The other two doors reuse it ────────────────
        const viaStatement = await at(home, () => statements.resolveSupplierByName({ supplierName: 'nimal produce', locCode: here }));
        assert(viaStatement.created === false && Number(viaStatement.supplier.id) === Number(started.id),
          'The statement page must reuse the supplier, not add another.');
        const [grnLines] = await connection.execute(
          'SELECT COUNT(*) AS n FROM suppliers WHERE loc_code = ? AND UPPER(name) = UPPER(?)', [here, 'Nimal Produce']
        );
        assert(Number(grnLines[0].n) === 1, `One name must mean one supplier, found ${grnLines[0].n}.`);
        passed.push('the statement page reuses the supplier the accounts page started');

        // Another location is free to use the same name for its own supplier.
        const twin = await at(other, () => catalog.createSupplier({ name: 'Nimal Produce', supplierCode: 'NIM-1' }));
        assert(twin.loc_code === elsewhere, 'Each location keeps its own supplier list.');
        passed.push('the same name is free at another location, which keeps its own list');

        // ── 5. Where it shows up ───────────────────────────
        const byActivity = await at(home, () => accounts.listAccounts({ locCode: here }));
        const everything = await at(home, () => accounts.listAccounts({ locCode: here, includeAll: true }));
        const idOf = (rows) => rows.some((row) => Number(row.supplierId) === Number(started.id));
        assert(!idOf(byActivity), 'A supplier with no entries must stay out of the default list.');
        assert(idOf(everything), 'A supplier with no entries must appear once the page asks for all of them.');
        passed.push('a supplier with no entries is hidden by default and shown when all are asked for');

        console.log('Supplier start invariants passed:');
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
