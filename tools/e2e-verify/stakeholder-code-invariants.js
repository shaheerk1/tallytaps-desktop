/**
 * Two people can share a name.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. the same name in another shop is added, with its own code and pocket;
 *   2. the same name again in one shop is added too, with a code of its own;
 *   3. each pocket belongs to its own person.
 */
const { runVerifier, assert } = require('./lib/ipc-harness');

const DATE = '2099-11-01';

runVerifier('Stakeholder code invariants', async (app) => {
  const { services, ok, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  await ok('locations.create', { location: { locCode: 'STA01', businessCode: 'STASHOP', name: 'Shop One' } });
  await ok('locations.create', { location: { locCode: 'STB01', businessCode: 'STBSHOP', name: 'Shop Two' } });
  const counter = await ok('workstations.create', { locationCode: 'STA01', machineCode: 'T1', name: 'Counter' });
  await logout();
  const session = await login('verify_admin', 'verify-admin-pass', counter.id, DATE);
  assert(session.success, `Sign-in failed: ${session.error}`);

  const add = (locCode, displayName) => ok('stakeholders.save', { stakeholder: { displayName, locCode, stakeholderType: 'partner' } });

  // ── 1. The same name in another shop ──────────────────────
  const first = await add('STA01', 'Khan');
  const other = await add('STB01', 'Khan');
  assert(first.stakeholderCode === 'KHAN', `The first Khan keeps the plain code, got ${first.stakeholderCode}.`);
  assert(other.id !== first.id, 'The other shop gets its own person.');
  passed.push('the same name in another shop is added, with a code of its own');

  // ── 2. The same name again in one shop ────────────────────
  const twin = await add('STA01', 'Khan');
  assert(twin.id !== first.id && twin.stakeholderCode !== first.stakeholderCode,
    `A second Khan in one shop needs a code of their own, got ${twin.stakeholderCode}.`);
  passed.push('the same name again in one shop is added too, with a code of its own');

  // ── 3. Each pocket is their own ───────────────────────────
  const pockets = await db(
    'SELECT id, fund_code, holder_name FROM fund_accounts WHERE id IN (?, ?, ?)',
    [first.fundAccountId, other.fundAccountId, twin.fundAccountId]
  );
  const codes = new Set(pockets.map((row) => row.fund_code));
  assert(pockets.length === 3 && codes.size === 3, `Each person keeps their own pocket, got ${JSON.stringify(pockets)}.`);
  passed.push('each pocket belongs to its own person');

  return passed;
});
