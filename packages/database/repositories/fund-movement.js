/**
 * The one way a settlement row lands in a fund.
 *
 * Money that names a fund has to reach that fund the moment it is taken or
 * handed over, the same way an expense leaves one -- otherwise the fund reads
 * 0.00 while the payment sits recorded against it. The accounting refresh in
 * operational-accounting derives the same rows for activity recorded before a
 * settlement posted its own, so both writers key on (source_type, source_id)
 * and whichever runs second finds the row and leaves it alone. The database
 * backs that up with uq_fund_movements_source.
 *
 * Nothing is written when no fund was named: cash belongs to the drawer's own
 * shift ledger, a cheque belongs to the cheque register, and stored advance is
 * a customer liability moving between documents -- none of them is money
 * arriving in a fund.
 */
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

const dateOnly = (value) => (value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value || '').slice(0, 10));

async function recordFundMovementWithConnection(connection, {
  fundAccountId, businessDayId, locCode, macCode, txnDate,
  direction, amount, sourceType, sourceId, reason, userId, metadata = {}
}) {
  if (!Number(fundAccountId)) return null;
  const value = money(amount);
  if (value <= 0) return null;
  const [existing] = await connection.execute(
    'SELECT id FROM fund_movements WHERE source_type = ? AND source_id = ? LIMIT 1',
    [sourceType, String(sourceId)]
  );
  if (existing[0]) return Number(existing[0].id);
  const [result] = await connection.execute(
    `INSERT INTO fund_movements
       (fund_account_id, business_day_id, loc_code, mac_code, txn_date,
        document_type, document_no, entry_no, direction, amount,
        source_type, source_id, reason, created_by, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
    [Number(fundAccountId), Number(businessDayId), locCode, macCode, dateOnly(txnDate),
      String(sourceType).slice(0, 40), Number(sourceId), direction, value,
      sourceType, String(sourceId), reason, Number(userId), JSON.stringify(metadata)]
  );
  return Number(result.insertId);
}

module.exports = { recordFundMovementWithConnection };
