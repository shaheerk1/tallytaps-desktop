/**
 * The real app, minus the window.
 *
 * Clones the current database -- schema, foreign keys, data and triggers -- into
 * a throwaway copy, boots the real service container and the real IPC registry
 * against it, and lets a verifier call the handlers exactly as the preload does,
 * token and all. The real database is only ever read; the copy is dropped when
 * `finish` runs, whatever happened.
 *
 * Testing through the IPC channel, not the repository underneath it, is the
 * point: a handler or preload bridge that was never wired shows up here as a
 * missing channel instead of passing unnoticed.
 *
 * Only `electron` is replaced: `ipcMain.handle` records handlers instead of
 * listening, so they can be called directly.
 */
const Module = require('module');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const SOURCE_DB = process.env.POS_DB_NAME || 'pos_platform';
const connectionConfig = {
  host: process.env.POS_DB_HOST || 'localhost',
  port: Number(process.env.POS_DB_PORT || 3306),
  user: process.env.POS_DB_USER || 'root',
  password: process.env.POS_DB_PASSWORD || 'root'
};

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

/** A faithful copy: tables with their keys, the rows, then the triggers. */
async function cloneDatabase(targetName) {
  const c = await mysql.createConnection({ ...connectionConfig, multipleStatements: true });
  try {
    await c.query(`CREATE DATABASE \`${targetName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await c.query('SET FOREIGN_KEY_CHECKS = 0');
    const [tables] = await c.query(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [SOURCE_DB]
    );
    for (const { name } of tables) {
      const [[created]] = await c.query(`SHOW CREATE TABLE \`${SOURCE_DB}\`.\`${name}\``);
      await c.query(`USE \`${targetName}\`; ${created['Create Table']}`);
      const [columns] = await c.query(
        `SELECT COLUMN_NAME AS col FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION`, [SOURCE_DB, name]
      );
      const list = columns.map(({ col }) => `\`${col}\``).join(', ');
      await c.query(`INSERT INTO \`${targetName}\`.\`${name}\` (${list}) SELECT ${list} FROM \`${SOURCE_DB}\`.\`${name}\``);
    }
    const [triggers] = await c.query('SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?', [SOURCE_DB]);
    for (const { name } of triggers) {
      const [[created]] = await c.query(`SHOW CREATE TRIGGER \`${SOURCE_DB}\`.\`${name}\``);
      const ddl = created['SQL Original Statement'].replace(/DEFINER=`[^`]+`@`[^`]+`\s*/, '');
      await c.query(`USE \`${targetName}\`; ${ddl}`);
    }
    await c.query('SET FOREIGN_KEY_CHECKS = 1');
    // A verification admin with a known password, in the copy only.
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('verify-admin-pass', salt, 64).toString('hex');
    const [admin] = await c.query(
      `INSERT INTO \`${targetName}\`.users (username, password_hash, display_name, email, status) VALUES ('verify_admin', ?, 'Verify Admin', 'verify@verify.local', 'active')`,
      [`${salt}:${hash}`]
    );
    await c.query(
      `INSERT INTO \`${targetName}\`.user_roles (user_id, role_id) SELECT ?, id FROM \`${targetName}\`.roles WHERE role_key = 'admin'`, [admin.insertId]
    );
    // Start with no open workstation sessions, as after everyone signs out.
    await c.query(`UPDATE \`${targetName}\`.workstation_sessions SET status = 'closed' WHERE status = 'open'`);
    return tables.length;
  } finally { await c.end(); }
}

async function dropDatabase(targetName) {
  const connection = await mysql.createConnection(connectionConfig);
  try { await connection.query(`DROP DATABASE IF EXISTS \`${targetName}\``); } finally { await connection.end(); }
}

/**
 * Boots the app on a fresh copy and returns what a verifier needs:
 *   services       the real container, for reading results and seeding
 *   call(ch, body) a handler call carrying the current session token
 *   ok(ch, body)   the same, throwing unless it succeeded
 *   login(user, password, workstationId, billingDate)
 *   logout()
 *   tableCount     how many tables were copied
 */
async function bootApp({ prefix = 'pos_platform_verify' } = {}) {
  const dbName = `${prefix}_${Date.now()}`;
  const tableCount = await cloneDatabase(dbName);
  process.env.POS_DB_NAME = dbName;
  const { createServiceContainer } = require('../../../apps/desktop/electron/main/service-container');
  const { registerIpcHandlers } = require('../../../apps/desktop/electron/ipc/ipc-registry');
  const services = await createServiceContainer();
  registerIpcHandlers(services);

  let token = null;
  const call = async (channel, payload = {}) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for ${channel}. Is it wired in ipc-registry.js?`);
    return fn(null, { ...payload, __token: token });
  };
  const ok = async (channel, payload) => {
    const result = await call(channel, payload);
    if (!result.success) throw new Error(`${channel} failed: ${result.error}`);
    return result.data;
  };
  const login = async (username, password, workstationId, billingDate = '2099-07-01') => {
    const result = await call('auth.login', { username, password, workstationId, billingDate });
    if (result.success) token = result.data.token;
    return result;
  };
  const logout = async () => {
    if (token) await call('auth.logout', { token });
    token = null;
  };

  return {
    services, handlers, call, ok, login, logout, tableCount, dbName,
    get token() { return token; },
    setToken(value) { token = value; }
  };
}

/** Runs a verifier against a booted copy and always drops the copy. */
function runVerifier(title, body, options = {}) {
  let app = null;
  (async () => {
    app = await bootApp(options);
    const passed = await body(app);
    console.log(`${title} passed:`);
    passed.forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
    await app.services.database.close();
  })()
    .then(async () => { await dropDatabase(app.dbName); console.log(`Throwaway database ${app.dbName} dropped.`); process.exit(0); })
    .catch(async (error) => {
      console.error(error.stack || error.message);
      if (app) {
        try { await dropDatabase(app.dbName); console.error(`Throwaway database ${app.dbName} dropped.`); } catch (dropError) { console.error(`Could not drop ${app.dbName}: ${dropError.message}`); }
      }
      process.exit(1);
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRefusal(promise, pattern, label) {
  const result = await promise;
  if (result.success) throw new Error(`${label} was accepted but should have been refused.`);
  if (pattern && !pattern.test(result.error || '')) throw new Error(`${label} was refused for the wrong reason: ${result.error}`);
  return result.error;
}

module.exports = { bootApp, runVerifier, cloneDatabase, dropDatabase, assert, expectRefusal };
