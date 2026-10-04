/**
 * Which supplier a typed name or code means, at one location.
 *
 * A supplier can be started from three places: a GRN, a supplier sales
 * statement, and the supplier accounts page. All three have to agree on when a
 * typed name is an existing supplier, because the answer decides whether the
 * money lands on the account the business already keeps or on a second one
 * beside it. A split ledger is quiet and expensive: the balance looks settled
 * on one and owing on the other.
 *
 * The rule: an active supplier of this location whose code or name matches,
 * ignoring case. A code match wins over a name match, because a code is the
 * deliberate identifier and a name is what someone typed in a hurry.
 *
 * `suppliers` enforces a unique code per location, but nothing stops two rows
 * sharing a name -- so matching on name here is what keeps them apart.
 */
async function findSupplierAtLocation(connection, { locCode, term }) {
  const typed = String(term || '').trim();
  const loc = String(locCode || '').trim();
  if (!typed || !loc) return null;
  const [matches] = await connection.execute(
    `SELECT * FROM suppliers
     WHERE loc_code = ? AND is_active = 1
       AND (UPPER(supplier_code) = UPPER(?) OR UPPER(name) = UPPER(?))
     ORDER BY UPPER(COALESCE(supplier_code, '')) = UPPER(?) DESC, id ASC
     LIMIT 1`,
    [loc, typed, typed, typed]
  );
  return matches[0] || null;
}

module.exports = { findSupplierAtLocation };
