/**
 * The trusted context of one IPC request.
 *
 * The main process resolves who is signed in and which workstation they are on
 * from the session token, then runs the handler inside this context. Any
 * service can read it without the value being threaded through every call, and
 * -- the point of it -- without trusting anything the screen sent.
 *
 * Outside an IPC request (migrations, verification scripts, schedulers) there
 * is no context. That code runs in the trusted main process, so services fall
 * back to the values they were given.
 */
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();
// Marks an IPC call on a channel that needs no sign-in. It has no identity,
// so anything that belongs to a location must refuse it rather than quietly
// answer with the shared values.
const anonymous = new AsyncLocalStorage();

function run(context, fn) {
  return storage.run(context, fn);
}

function runAnonymous(fn) {
  return anonymous.run(true, fn);
}

function isAnonymousRequest() {
  return anonymous.getStore() === true && !storage.getStore();
}

function current() {
  return storage.getStore() || null;
}

/** The workstation the signed-in user is on, or null when none is open. */
function workstation() {
  return current()?.workstation || null;
}

/**
 * Where a write happens. Inside a request it is always the session's own
 * location, terminal, and business date; the input is ignored. Outside a
 * request the caller is trusted main-process code, so its input is used.
 */
function resolveOrigin(input = {}) {
  const context = current();
  if (context) {
    const ws = context.workstation;
    if (!ws) throw new Error('Open a workstation session before recording this. Sign out and sign in to a workstation.');
    return { locCode: ws.locCode, macCode: ws.macCode, txnDate: ws.businessDate };
  }
  const origin = input.origin || input;
  return {
    locCode: String(origin.locCode || '').trim(),
    macCode: String(origin.macCode || '').trim(),
    txnDate: String(origin.txnDate || '').slice(0, 10)
  };
}

/** The location whose data a read may see. Same trust rule as resolveOrigin. */
function resolveLocation(input = {}) {
  const context = current();
  if (context) {
    const ws = context.workstation;
    if (!ws) throw new Error('Open a workstation session before viewing this. Sign out and sign in to a workstation.');
    return ws.locCode;
  }
  return String(input.locCode || input.locationCode || input.origin?.locCode || '').trim();
}

/**
 * The location a master-data query is limited to. Inside a request it is the
 * session's location (and a request without a workstation sees nothing).
 * Outside one, trusted code may pass a location or null for no limit.
 */
function scopedLocation(input = {}) {
  const context = current();
  if (context) return context.workstation ? context.workstation.locCode : '__no_workstation__';
  const loc = String(input?.locCode || input?.locationCode || '').trim();
  return loc || null;
}

/** The signed-in user. Same trust rule as resolveOrigin. */
function resolveUserId(input = {}) {
  const context = current();
  if (context) return Number(context.user.id);
  return Number(input.userId || 0) || null;
}

module.exports = { run, runAnonymous, isAnonymousRequest, current, workstation, resolveOrigin, resolveLocation, resolveUserId, scopedLocation };
