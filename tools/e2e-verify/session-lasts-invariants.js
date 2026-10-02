/**
 * A sign-in lasts until someone signs out.
 *
 * Boots the real app on a throwaway copy of the database (see lib/ipc-harness):
 *
 *   1. a fresh sign-in is made with no end date, and works;
 *   2. an end date, if one is ever set, is still honoured;
 *   3. the cleanup sweeps only sessions that carry a date that has passed;
 *   4. signing out still ends the session there and then.
 */
const { runVerifier, assert, expectRefusal } = require('./lib/ipc-harness');

runVerifier('Session lasts until sign-out invariants', async (app) => {
  const { services, ok, call, login, logout } = app;
  const passed = [];
  const db = (sql, params = []) => services.database.withConnection((c) => c.execute(sql, params)).then(([rows]) => rows);
  /** The context is cached for a few seconds; a row changed underneath it is not seen until it is dropped. */
  const forget = () => services.sessionContextService.invalidate(app.token);

  const admin = await login('verify_admin', 'verify-admin-pass', null);
  assert(admin.success, `Admin sign-in failed: ${admin.error}`);
  const userId = Number(admin.data.user.id);
  const token = app.token;

  // ── 1. No end date, and it works ──────────────────────────
  const [row] = await db('SELECT expires_at FROM sessions WHERE token = ?', [token]);
  assert(row && row.expires_at === null,
    `A new sign-in must carry no end date, got ${JSON.stringify(row)}.`);
  assert(admin.data.expiresAt === null || admin.data.expiresAt === undefined,
    `Sign-in must report no end date, got ${admin.data.expiresAt}.`);
  const working = await call('catalog.products.list', {});
  assert(working.success, `A signed-in request must go through, got ${working.error}.`);
  passed.push('a new sign-in is made with no end date and is accepted');

  // ── 2. A date, if ever set, still ends it ─────────────────
  await db('UPDATE sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE token = ?', [token]);
  forget();
  await expectRefusal(call('catalog.products.list', {}), /session has ended/i, 'a sign-in whose end date has passed');
  await db('UPDATE sessions SET expires_at = NULL WHERE token = ?', [token]);
  forget();
  const again = await call('catalog.products.list', {});
  assert(again.success, `With the date taken off again the sign-in must work, got ${again.error}.`);
  passed.push('an end date, where one is set, is still honoured');

  // ── 3. Cleanup takes the dated and passed, nothing else ───
  await db("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'verify-stale-token', DATE_SUB(NOW(), INTERVAL 2 DAY))", [userId]);
  await db("INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'verify-dated-token', DATE_ADD(NOW(), INTERVAL 2 DAY))", [userId]);
  await ok('auth.cleanup', {});
  const left = await db('SELECT token FROM sessions WHERE token IN (?, ?, ?)', [token, 'verify-stale-token', 'verify-dated-token']);
  const tokens = left.map((each) => each.token);
  assert(!tokens.includes('verify-stale-token'), 'A session whose date has passed must be swept away.');
  assert(tokens.includes('verify-dated-token'), 'A session whose date is still ahead must be left alone.');
  assert(tokens.includes(token), 'A session with no end date must never be swept away.');
  passed.push('the cleanup takes only sessions whose end date has passed');

  // ── 4. Signing out still ends it ──────────────────────────
  await logout();
  app.setToken(token);
  await expectRefusal(call('catalog.products.list', {}), /session has ended/i, 'a request after signing out');
  passed.push('signing out still ends the session at once');

  return passed;
});
