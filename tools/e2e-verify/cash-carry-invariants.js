/**
 * Drawer cash carried between shifts, through the real IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. a drawer's first shift opens with any float;
 *   2. after it closes, the next opening is expected to match the cash counted
 *      at close, and Money shows that cash still in the drawer;
 *   3. a different opening count is refused without a reason;
 *   4. with a reason, the shortage or excess is kept on the new shift;
 *   5. a matching count opens with no difference.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';

runVerifier('Cash carry invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'CCY01', businessCode: 'CCYSHOP', name: 'Carry Shop' } });
  const counter = await ok('workstations.create', { locationCode: 'CCY01', machineCode: 'A1', name: 'Till' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES ('CCY01', ?, 'open', ?)", [DATE, userId]);
  const [workstationSession] = await db("SELECT id FROM workstation_sessions WHERE workstation_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [counter.id]);
  const open = (lines, reason) => call('cash.openShift', { shift: {
    workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE, openingLines: lines, openingDifferenceReason: reason
  } });
  const closeWith = async (shiftId, lines, varianceReason = 'Counted') => {
    await ok('cash.blindClose', { count: { shiftId, userId, closingLines: lines } });
    await ok('cash.closeShift', { close: { shiftId, userId, varianceReason } });
  };

  // ── 1. The first shift opens with any float ───────────────
  assert(await ok('cash.openingExpectation', { workstationId: counter.id }) === null, 'A new drawer has nothing to carry.');
  const first = await open([{ denomination: 1000, quantity: 5 }]);
  assert(first.success && first.data.carriedInTotal == null, `The first shift must open freely, got ${first.error}.`);
  passed.push("a drawer's first shift opens with any float");

  // ── 2. After closing, the count stays in the drawer ───────
  await ok('cash.addMovement', { movement: { shiftId: first.data.id, type: 'cash_in', amount: 2500, reason: 'Sales cash' } });
  await closeWith(first.data.id, [{ denomination: 1000, quantity: 7 }, { denomination: 500, quantity: 1 }]); // 7,500 counted
  const expectation = await ok('cash.openingExpectation', { workstationId: counter.id });
  assert(expectation && expectation.carriedTotal === 7500 && expectation.lines.length === 2, `The next shift should expect 7,500, got ${JSON.stringify(expectation)}.`);
  const drawerFund = (await ok('funds.list', { locCode: 'CCY01', includeInactive: false })).find((fund) => fund.fundKind === 'pos_drawer');
  assert(drawerFund && drawerFund.balance === 7500, `Money must show 7,500 left in the drawer, got ${drawerFund?.balance}.`);
  passed.push('the cash counted at close stays in the drawer, and Money shows it');

  // ── 3. A different count needs a reason ───────────────────
  const refused = await open([{ denomination: 1000, quantity: 7 }]);
  assert(!refused.success && /7500\.00 left in this drawer/.test(refused.error || '') && /short 500\.00/.test(refused.error || ''),
    `A short opening without a reason must be refused, got ${refused.error}.`);
  passed.push('a different opening count is refused without a reason');

  // ── 4. With a reason it is kept on the shift ──────────────
  const second = await open([{ denomination: 1000, quantity: 7 }], 'Owner took 500 for lunch');
  assert(second.success && second.data.carriedInTotal === 7500 && second.data.openingDifference === -500 && second.data.openingDifferenceReason === 'Owner took 500 for lunch',
    `The shortage and its reason must be kept, got ${JSON.stringify(second.data || second.error)}.`);
  passed.push('with a reason, the shortage or excess is kept on the new shift');

  // ── 5. A matching count opens cleanly ─────────────────────
  await closeWith(second.data.id, [{ denomination: 1000, quantity: 7 }]);
  const third = await open([{ denomination: 1000, quantity: 7 }]);
  assert(third.success && third.data.carriedInTotal === 7000 && third.data.openingDifference === 0, `A matching count opens with no difference, got ${JSON.stringify(third.data || third.error)}.`);
  await expectRefusal(call('cash.openShift', { shift: { workstationSessionId: workstationSession.id, workstationId: counter.id, userId, businessDate: DATE, openingLines: [] } }), /already has an active shift/, 'a second active shift');
  passed.push('a matching count opens with no difference');

  return passed;
});
