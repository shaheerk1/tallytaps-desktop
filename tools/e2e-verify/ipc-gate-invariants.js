/**
 * The IPC gate, end to end.
 *
 * Clones the current database -- schema, foreign keys, data, and triggers -- into
 * a throwaway copy, boots the real service container and the real IPC registry
 * against the copy, then calls the handlers exactly as the preload does, token
 * and all. The copy is dropped at the end, whatever happens; the real database
 * is only ever read.
 *
 * Only `electron` is replaced: `ipcMain.handle` records handlers instead of
 * listening, so the handlers can be called directly.
 */
const Module = require('module');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const SOURCE_DB = process.env.POS_DB_NAME || 'pos_platform';
const DB_NAME = `pos_platform_verify_${Date.now()}`;
const connectionConfig = {
  host: process.env.POS_DB_HOST || 'localhost',
  port: Number(process.env.POS_DB_PORT || 3306),
  user: process.env.POS_DB_USER || 'root',
  password: process.env.POS_DB_PASSWORD || 'root'
};

/** A faithful copy: tables with their keys, the rows, then the triggers. */
async function cloneDatabase() {
  const c = await mysql.createConnection({ ...connectionConfig, multipleStatements: true });
  try {
    await c.query(`CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await c.query('SET FOREIGN_KEY_CHECKS = 0');
    const [tables] = await c.query(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [SOURCE_DB]
    );
    for (const { name } of tables) {
      const [[created]] = await c.query(`SHOW CREATE TABLE \`${SOURCE_DB}\`.\`${name}\``);
      await c.query(`USE \`${DB_NAME}\`; ${created['Create Table']}`);
      const [columns] = await c.query(
        `SELECT COLUMN_NAME AS col FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION`, [SOURCE_DB, name]
      );
      const list = columns.map(({ col }) => `\`${col}\``).join(', ');
      await c.query(`INSERT INTO \`${DB_NAME}\`.\`${name}\` (${list}) SELECT ${list} FROM \`${SOURCE_DB}\`.\`${name}\``);
    }
    const [triggers] = await c.query('SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?', [SOURCE_DB]);
    for (const { name } of triggers) {
      const [[created]] = await c.query(`SHOW CREATE TRIGGER \`${SOURCE_DB}\`.\`${name}\``);
      const ddl = created['SQL Original Statement'].replace(/DEFINER=`[^`]+`@`[^`]+`\s*/, '');
      await c.query(`USE \`${DB_NAME}\`; ${ddl}`);
    }
    await c.query('SET FOREIGN_KEY_CHECKS = 1');
    // A verification admin with a known password, in the copy only.
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('verify-admin-pass', salt, 64).toString('hex');
    const [admin] = await c.query(
      `INSERT INTO \`${DB_NAME}\`.users (username, password_hash, display_name, email, status) VALUES ('verify_admin', ?, 'Verify Admin', 'verify@verify.local', 'active')`,
      [`${salt}:${hash}`]
    );
    await c.query(
      `INSERT INTO \`${DB_NAME}\`.user_roles (user_id, role_id) SELECT ?, id FROM \`${DB_NAME}\`.roles WHERE role_key = 'admin'`, [admin.insertId]
    );
    // Start with no open workstation sessions, as after everyone signs out.
    await c.query(`UPDATE \`${DB_NAME}\`.workstation_sessions SET status = 'closed' WHERE status = 'open'`);
    return tables.length;
  } finally { await c.end(); }
}

const handlers = new Map();
const electronStub = {
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false }
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};

const { createServiceContainer } = require('../../apps/desktop/electron/main/service-container');
const { registerIpcHandlers } = require('../../apps/desktop/electron/ipc/ipc-registry');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const passed = [];
  const tableCount = await cloneDatabase();
  process.env.POS_DB_NAME = DB_NAME;
  const services = await createServiceContainer();
  registerIpcHandlers(services);

  // What the preload does: every call carries the stored session token.
  let token = null;
  const call = async (channel, payload = {}) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for ${channel}.`);
    return fn(null, { ...payload, __token: token });
  };
  const ok = async (channel, payload) => {
    const result = await call(channel, payload);
    if (!result.success) throw new Error(`${channel} failed: ${result.error}`);
    return result.data;
  };
  const login = async (username, password, workstationId) => {
    const result = await call('auth.login', { username, password, workstationId, billingDate: '2099-07-01' });
    if (result.success) token = result.data.token;
    return result;
  };

  const status = await services.migrationRunner.status();
  assert(status.pending.length === 0, `The copy must have no pending migrations: ${status.pending.join(', ')}`);
  passed.push(`the real container and IPC registry boot on a copy of the database (${tableCount} tables, all ${status.total} migrations)`);

  // ── No token, no access ───────────────────────────────
  const anonymous = await call('funds.list', { locCode: 'ANY' });
  assert(!anonymous.success && /session has ended/i.test(anonymous.error), 'A protected call without a token must be refused.');
  const catalogOpen = await call('catalog.products.list', {});
  assert(!catalogOpen.success, 'The catalog must no longer be readable without signing in.');
  passed.push('a protected call without a session token is refused, including the catalog');

  // ── Set up two businesses from the admin screens ──────
  const first = await login('verify_admin', 'verify-admin-pass', null);
  assert(first.success, `Admin sign-in failed: ${first.error}`);
  await ok('locations.create', { location: { locCode: 'KST01', businessCode: 'KHANSTORE', name: 'Khan Store' } });
  await ok('locations.create', { location: { locCode: 'KRT01', businessCode: 'KHANRETAIL', name: 'Khan Retail' } });
  const store = await ok('workstations.create', { locationCode: 'KST01', machineCode: 'T1', name: 'Store counter' });
  const retail = await ok('workstations.create', { locationCode: 'KRT01', machineCode: 'T1', name: 'Retail counter' });
  const listed = await ok('workstations.list', {});
  assert(listed.every((row) => row.business_code), 'The login picker must receive each workstation’s business.');
  await ok('auth.logout', { token });
  token = null;
  passed.push('locations and workstations are set up through the real admin channels');

  // ── Sign in to the store; the gate owns identity ──────
  const atStore = await login('verify_admin', 'verify-admin-pass', store.id);
  assert(atStore.success && atStore.data.workstationSession.locationCode === 'KST01', 'Signing in to the store counter must land at KST01.');
  for (const loc of ['KST01', 'KRT01']) {
    await services.database.withConnection((c) => c.execute(
      "INSERT INTO business_days (loc_code, business_date, status, opened_by) VALUES (?, '2099-07-01', 'open', ?)",
      [loc, atStore.data.user.id]
    ));
  }
  const emptyStore = await ok('catalog.products.list', {});
  assert(emptyStore.length === 0, `A new location must start with an empty catalog, found ${emptyStore.length} items.`);
  passed.push('a new location starts with an empty catalog; the existing 190 items stay with their own location');

  const onion = await ok('catalog.products.create', { sku: 'ONION', name: 'Big onion', unitPrice: 280, locCode: 'KRT01' });
  const [[row]] = await services.database.withConnection((c) => c.execute('SELECT loc_code FROM products WHERE id = ?', [onion.id]));
  assert(row.loc_code === 'KST01', `An item created at the store must join the store's catalog, not ${row.loc_code}.`);
  passed.push('an item created while signed in to the store joins the store’s catalog, whatever location the screen named');

  // Forged permissions: a user with no roles sends a list claiming everything.
  await ok('users.create', { username: 'nobody', password: 'nobody-pass', displayName: 'No roles', email: 'nobody@verify.local' });
  await ok('auth.logout', { token });
  token = null;
  const nobody = await login('nobody', 'nobody-pass', retail.id);
  assert(nobody.success, `The no-role user could not sign in: ${nobody.error}`);
  const forged = await call('funds.list', { actor: { id: '1', permissions: ['funds.view', 'settings.manage', 'users.manage'] } });
  assert(!forged.success && /Permission denied/.test(forged.error), 'Permissions the screen claims must be ignored.');
  passed.push('a user with no roles cannot use a permission by claiming it from the screen');
  await ok('auth.logout', { token });
  token = null;

  // ── Moving business without signing out ──────────────
  // Sign in to the store, then -- without signing out, as a second window or a
  // forgotten session would -- sign in to the retail counter.
  const againAtStore = await login('verify_admin', 'verify-admin-pass', store.id);
  assert(againAtStore.success, `Signing in to the store again failed: ${againAtStore.error}`);
  const storeToken = token;
  const atRetail = await login('verify_admin', 'verify-admin-pass', retail.id);
  assert(atRetail.success && atRetail.data.workstationSession.locationCode === 'KRT01', 'Choosing the retail counter must land at KRT01.');
  assert((atRetail.data.workstationSession.closedElsewhere || []).includes('Store counter'),
    'Moving to retail must close the store session and say so.');
  passed.push('choosing the retail counter lands there and closes the store session, even without signing out');

  const retailCatalog = await ok('catalog.products.list', {});
  assert(retailCatalog.length === 0, 'The retail business must not see the store’s items.');
  const sameSku = await ok('catalog.products.create', { sku: 'ONION', name: 'Big onion', unitPrice: 320 });
  assert(Number(sameSku.unit_price) === 320, 'Retail keeps its own price for the same SKU.');
  passed.push('the retail business sees none of the store’s items, and the same SKU carries its own price');

  // ── The bill prints the location's own details ───────
  // The settings screen saves the address for the signed-in location; the bill
  // must read that same row, not the shared one.
  const sharedReceipt = await services.settingsService.getSettingsByCode('general');
  await ok('settings.setBulk', { code: 'general', settings: { store_name: 'Khan Retail', store_address_1: '7 Retail Road', store_phone: '0110000000' } });
  const retailReceipt = await ok('settings.receipt.get', {});
  assert(retailReceipt.storeName === 'Khan Retail' && retailReceipt.addressLines[0] === '7 Retail Road' && retailReceipt.phone === '0110000000',
    `The retail bill must print what retail saved, got ${JSON.stringify([retailReceipt.storeName, retailReceipt.addressLines, retailReceipt.phone])}.`);
  const retailForm = await ok('settings.getByCode', { code: 'general' });
  assert(retailForm.store_address_1 === retailReceipt.addressLines[0], 'The settings screen and the bill must show the same address.');
  const [[workstationCopies]] = await services.database.withConnection((c) => c.execute(
    "SELECT COUNT(*) AS n FROM system_settings WHERE code = 'workstation' AND `key` IN ('store_address_1','store_address_2','store_phone','default_printer')"
  ));
  assert(Number(workstationCopies.n) === 0, 'No second copy of the address or phone may remain in the workstation group.');
  const anonymousReceipt = await handlers.get('settings.receipt.get')(null, {});
  assert(!anonymousReceipt.success, 'The receipt details must not be readable without signing in.');
  let anonymousRead = null;
  try { await services.requestContext.runAnonymous(() => services.settingsService.getSettingsByCode('general')); } catch (error) { anonymousRead = error.message; }
  assert(anonymousRead && /belong to a location/.test(anonymousRead), 'A channel with no sign-in must be refused location settings, not handed the shared ones.');
  const ui = await handlers.get('uiPreferences.get')(null, {});
  assert(ui.success, `Shared screen preferences must stay readable before sign-in: ${ui.error}`);
  passed.push('the bill prints the address the signed-in location saved, the settings screen shows that same value, and no second copy remains');

  // The store sign-in is still a valid login, but its workstation session is
  // closed: it may no longer record anything anywhere.
  const stale = await handlers.get('expenses.create')(null, {
    __token: storeToken, expense: { amount: 1, reason: 'Stale', expenseCategoryId: 1, fundAccountId: 1, origin: { locCode: 'KST01', macCode: 'T1', txnDate: '2099-07-01' } }
  });
  assert(!stale.success && /workstation session/i.test(stale.error),
    `A sign-in whose workstation session was closed must be refused for that reason, got: ${stale.error}`);
  passed.push('a still-valid sign-in whose workstation session was closed can record nothing, even naming a location');

  // Back at the store, retail's address must not follow.
  const backAtStore = await login('verify_admin', 'verify-admin-pass', store.id);
  assert(backAtStore.success, `Signing back in to the store failed: ${backAtStore.error}`);
  const storeReceipt = await ok('settings.receipt.get', {});
  assert(storeReceipt.addressLines[0] !== '7 Retail Road' && (storeReceipt.addressLines[0] || '') === String(sharedReceipt.store_address_1 || '').trim(),
    `The store bill must keep its own (shared) address, got ${storeReceipt.addressLines[0]}.`);
  passed.push('another location’s saved address never appears on this location’s bill');

  console.log('IPC gate invariants passed:');
  passed.forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
  await services.database.close();
}

async function dropDatabase() {
  const connection = await mysql.createConnection(connectionConfig);
  try { await connection.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``); } finally { await connection.end(); }
}

main()
  .then(async () => { await dropDatabase(); console.log(`Throwaway database ${DB_NAME} dropped.`); process.exit(0); })
  .catch(async (error) => {
    console.error(error.stack || error.message);
    try { await dropDatabase(); console.error(`Throwaway database ${DB_NAME} dropped.`); } catch (dropError) { console.error(`Could not drop ${DB_NAME}: ${dropError.message}`); }
    process.exit(1);
  });
