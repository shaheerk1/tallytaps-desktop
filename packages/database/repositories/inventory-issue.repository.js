/**
 * Outward stock issues: goods leaving the shop on someone else's lorry.
 *
 * This is deliberately not a stock count. A count answers "what is physically
 * here" and only ever wrote one measure, which let a lot's bags and kilos drift
 * apart. An issue states what left, in both measures, and to whom.
 */
function createInventoryIssueRepository({ database, documentSequenceRepository, businessDayRepository, inventoryLedgerRepository }) {
  if (!database) throw new Error('Inventory issue repository requires a database instance.');
  if (!documentSequenceRepository) throw new Error('Inventory issue repository requires document sequences.');
  if (!businessDayRepository) throw new Error('Inventory issue repository requires business-day control.');
  if (!inventoryLedgerRepository) throw new Error('Inventory issue repository requires the inventory ledger.');

  const text = (value, max = 255) => String(value ?? '').trim().slice(0, max);
  const measure = (value) => (value == null || value === '' ? null : Math.round(Number(value) * 1000) / 1000);
  const money = (value) => Math.round(Number(value || 0) * 100) / 100;

  /**
   * Records one outward load and posts it to the inventory ledger. Both the
   * handling and base measure move together, so a lot can never again show
   * bags that disagree with its kilos.
   */
  async function createIssue({
    locCode, macCode, businessDate, destination, vehicleNumber = null,
    weighbridgeTicket = null, weighbridgeNetQuantity = null, weighbridgeCharge = 0,
    reason = null, lines, userId = null
  }) {
    const shopName = text(destination, 160);
    if (!shopName) throw new Error('Name the shop or place these goods are going to.');
    if (!businessDate) throw new Error('A business date is required.');
    if (!Array.isArray(lines) || !lines.length) throw new Error('Add at least one lot to send out.');

    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const businessDay = await businessDayRepository.assertOpenWithConnection(connection, {
          locationCode: locCode, businessDate
        });
        const issueNo = await documentSequenceRepository.allocateWithConnection(connection, {
          documentType: 'inventory_issue', locCode, macCode, txnDate: businessDate
        });
        const [header] = await connection.execute(
          `INSERT INTO inventory_issues
             (business_day_id, loc_code, mac_code, issue_no, business_date, status, destination,
              vehicle_number, weighbridge_ticket, weighbridge_net_quantity, weighbridge_charge, reason, issued_by)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
          [businessDay.id, locCode, macCode, issueNo, businessDate, shopName,
            text(vehicleNumber, 60) || null, text(weighbridgeTicket, 80) || null,
            measure(weighbridgeNetQuantity), money(weighbridgeCharge), text(reason) || null, userId || null]
        );
        const issueId = header.insertId;

        let lineNo = 0;
        for (const line of lines) {
          lineNo += 1;
          const [lots] = await connection.execute('SELECT * FROM inventory_lots WHERE id = ? FOR UPDATE', [line.inventoryLotId]);
          if (!lots.length) throw new Error('That stock lot no longer exists.');
          const lot = lots[0];

          const handling = measure(line.handlingQuantity);
          const base = measure(line.baseQuantity);
          if (handling == null || !(handling > 0)) throw new Error('Enter how many bags are leaving.');

          // A lot that tracks a second measure must state both. This single
          // rule is what the stock-count route was missing.
          const lotTracksBase = lot.remaining_base_quantity != null || lot.base_uom_snapshot != null;
          if (lotTracksBase && (base == null || !(base > 0))) {
            throw new Error(`${lot.lot_code} is measured in ${lot.base_uom_snapshot || 'a second unit'} as well. Enter that quantity too.`);
          }

          const remainingHandling = Number(lot.remaining_handling_quantity || 0);
          if (handling > remainingHandling + 0.0005) {
            throw new Error(`${lot.lot_code} has only ${remainingHandling} left to send out.`);
          }
          if (base != null && lot.remaining_base_quantity != null) {
            const remainingBase = Number(lot.remaining_base_quantity || 0);
            if (base > remainingBase + 0.0005) {
              throw new Error(`${lot.lot_code} has only ${remainingBase} ${lot.base_uom_snapshot || ''} left to send out.`);
            }
          }

          await connection.execute(
            `INSERT INTO inventory_issue_lines
               (issue_id, loc_code, mac_code, business_date, issue_no, line_no, inventory_lot_id, product_id,
                handling_quantity, base_quantity, handling_uom_snapshot, base_uom_snapshot, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [issueId, locCode, macCode, businessDate, issueNo, lineNo, lot.id, lot.product_id,
              handling, base, lot.handling_uom_snapshot, lot.base_uom_snapshot, text(line.note) || null]
          );

          await connection.execute(
            `UPDATE inventory_lots
             SET remaining_handling_quantity = remaining_handling_quantity - ?,
                 remaining_quantity = remaining_quantity - ?,
                 remaining_base_quantity = CASE WHEN remaining_base_quantity IS NULL THEN NULL ELSE remaining_base_quantity - ? END,
                 remaining_kilos = CASE WHEN remaining_kilos IS NULL THEN NULL ELSE remaining_kilos - ? END
             WHERE id = ?`,
            [handling, handling, base || 0, base || 0, lot.id]
          );

          // A weighed load is a weighbridge reading in the lot's measurement
          // history; an unweighed one is simply what left.
          const measurementType = measure(weighbridgeNetQuantity) != null ? 'weighbridge' : 'issue';
          await connection.execute(
            `INSERT INTO inventory_measurements
               (inventory_lot_id, loc_code, mac_code, txn_date, document_type, document_no, line_no, event_no,
                measurement_type, package_qty, kilos, reason, recorded_by)
             VALUES (?, ?, ?, ?, 'inventory_issue', ?, ?, 1, ?, ?, ?, ?, ?)`,
            [lot.id, locCode, macCode, businessDate, issueNo, lineNo, measurementType, handling, base,
              `Sent to ${shopName}`, userId || null]
          );

          await inventoryLedgerRepository.postWithConnection(connection, {
            productId: lot.product_id,
            inventoryLotId: lot.id,
            locCode, macCode, businessDate,
            documentType: 'inventory_issue',
            documentNo: issueNo,
            lineNo,
            eventNo: 1,
            movementType: 'issue',
            referenceType: 'inventory_issue',
            referenceId: issueId,
            note: `Sent to ${shopName}`,
            createdBy: userId,
            handlingDelta: -handling,
            baseDelta: base == null ? null : -base,
            handlingUom: lot.handling_uom_snapshot,
            baseUom: lot.base_uom_snapshot
          });
        }

        await connection.execute(
          `UPDATE inventory_issues SET status = 'finalized', finalized_at = NOW() WHERE id = ?`,
          [issueId]
        );
        await connection.commit();
        return { id: issueId, issueNo, destination: shopName, businessDate, lineCount: lineNo };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  /** Records which expense paid for this load's weighing, once it is attached. */
  async function linkWeighbridgeExpense(issueId, expenseEntryId) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        'UPDATE inventory_issues SET weighbridge_expense_entry_id = ? WHERE id = ?',
        [expenseEntryId || null, Number(issueId)]
      );
    });
  }

  async function listIssues({ locCode, fromDate = null, toDate = null, limit = 100 } = {}) {
    const location = text(locCode, 50);
    if (!location) throw new Error('A location is required.');
    const rowLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const clauses = ['i.loc_code = ?'];
    const params = [location];
    if (fromDate) { clauses.push('i.business_date >= ?'); params.push(fromDate); }
    if (toDate) { clauses.push('i.business_date <= ?'); params.push(toDate); }
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT i.*, u.display_name AS issued_by_name,
                (SELECT COUNT(*) FROM inventory_issue_lines l WHERE l.issue_id = i.id) AS line_count
         FROM inventory_issues i LEFT JOIN users u ON u.id = i.issued_by
         WHERE ${clauses.join(' AND ')}
         ORDER BY i.business_date DESC, i.issue_no DESC LIMIT ${rowLimit}`,
        params
      );
      const ids = rows.map((row) => row.id);
      let linesByIssue = new Map();
      if (ids.length) {
        const [lineRows] = await connection.query(
          `SELECT l.*, p.name AS product_name, p.sku, lot.lot_code
           FROM inventory_issue_lines l
           JOIN products p ON p.id = l.product_id
           JOIN inventory_lots lot ON lot.id = l.inventory_lot_id
           WHERE l.issue_id IN (?) ORDER BY l.issue_id, l.line_no`,
          [ids]
        );
        linesByIssue = lineRows.reduce((map, row) => {
          const list = map.get(row.issue_id) || [];
          list.push({
            lineNo: row.line_no, inventoryLotId: row.inventory_lot_id, lotCode: row.lot_code,
            productId: row.product_id, productName: row.product_name, sku: row.sku,
            handlingQuantity: Number(row.handling_quantity),
            baseQuantity: row.base_quantity == null ? null : Number(row.base_quantity),
            handlingUom: row.handling_uom_snapshot, baseUom: row.base_uom_snapshot, note: row.note
          });
          map.set(row.issue_id, list);
          return map;
        }, new Map());
      }
      return rows.map((row) => ({
        id: row.id, issueNo: row.issue_no, businessDate: row.business_date, status: row.status,
        destination: row.destination, vehicleNumber: row.vehicle_number,
        weighbridgeTicket: row.weighbridge_ticket,
        weighbridgeNetQuantity: row.weighbridge_net_quantity == null ? null : Number(row.weighbridge_net_quantity),
        weighbridgeCharge: Number(row.weighbridge_charge || 0),
        weighbridgeExpenseEntryId: row.weighbridge_expense_entry_id,
        reason: row.reason, issuedByName: row.issued_by_name,
        lineCount: Number(row.line_count || 0),
        lines: linesByIssue.get(row.id) || []
      }));
    });
  }

  return { createIssue, linkWeighbridgeExpense, listIssues };
}

module.exports = { createInventoryIssueRepository };
