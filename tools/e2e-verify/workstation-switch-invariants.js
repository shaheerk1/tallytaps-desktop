/**
 * Switching workstation without signing out, through the real IPC channel.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. with a cash shift open on workstation A, switching to B works and the
 *      shift is left open, exactly as signing out and in would;
 *   2. after the switch every request comes from B;
 *   3. switching back to A finds the same open shift again;
 *   4. a workstation that cannot be used is refused and the user stays put.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

const DATE = '2099-11-01';

runVerifier('Workstation switch invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'WSA01', businessCode: 'WSASHOP', name: 'Shop A' } });
  await ok('locations.create', { location: { locCode: 'WSB01', businessCode: 'WSBSHOP', name: 'Shop B' } });
  const a = await ok('workstations.create', { locationCode: 'WSA01', machineCode: 'A1', name: 'Counter A' });
  const b = await ok('workstations.create', { locationCode: 'WSB01', machineCode: 'B1', name: 'Counter B' });
  const retired = await ok('workstations.create', { locationCode: 'WSB01', machineCode: 'B9', name: 'Old counter' });
  await ok('workstations.update', { id: retired.id, status: 'inactive' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', a.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);
  const userId = Number(session.data.user.id);
  for (const loc of ['WSA01', 'WSB01']) {
    await db("INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, ?, 'open', ?)", [loc, DATE, userId]);
  }
  const sessionA = session.data.workstationSession.sessionId;
  const shift = await ok('cash.openShift', { shift: {
    workstationSessionId: sessionA, workstationId: a.id, userId, businessDate: DATE, openingLines: [{ denomination: 1000, quantity: 3 }]
  } });

  // ── 1. Switching with a shift open ────────────────────────
  const onB = await ok('workstations.switch', { targetWorkstationId: b.id, billingDate: DATE });
  assert(onB.workstationId === b.id && onB.locationCode === 'WSB01', `The switch must land on B, got ${JSON.stringify(onB)}.`);
  const [shiftRow] = await db('SELECT status FROM cash_shifts WHERE id = ?', [shift.id]);
  assert(shiftRow.status === 'open', `The shift on A must stay open, got ${shiftRow.status}.`);
  passed.push('with a cash shift open on A, switching to B works and leaves the shift open');

  // ── 2. Requests now come from B ───────────────────────────
  const active = await ok('workstations.activeSession', {});
  assert(active && active.workstationId === b.id, `The sign-in must now be on B, got ${JSON.stringify(active)}.`);
  const [aSession] = await db('SELECT status FROM workstation_sessions WHERE id = ?', [sessionA]);
  assert(aSession.status === 'closed', 'The session on A is closed, as signing out would.');
  passed.push('after the switch every request comes from B');

  // ── 3. Back to A finds the shift ──────────────────────────
  const backOnA = await ok('workstations.switch', { targetWorkstationId: a.id, billingDate: DATE });
  assert(backOnA.workstationId === a.id, 'The switch back must land on A.');
  const recovered = await ok('cash.recoverableShift', { workstationId: a.id, userId });
  assert(recovered && recovered.id === shift.id && recovered.status === 'open', `Back on A, the same open shift must be found, got ${JSON.stringify(recovered && { id: recovered.id, status: recovered.status })}.`);
  passed.push('switching back to A finds the same open shift');

  // ── 4. An unusable workstation is refused ─────────────────
  await expectRefusal(call('workstations.switch', { targetWorkstationId: retired.id, billingDate: DATE }), /inactive/, 'switching to an inactive workstation');
  const still = await ok('workstations.activeSession', {});
  assert(still && still.workstationId === a.id, `A refused switch must leave the user on A, got ${JSON.stringify(still)}.`);
  passed.push('a workstation that cannot be used is refused and the user stays put');

  return passed;
});
