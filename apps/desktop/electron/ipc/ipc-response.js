const { ipcMain } = require('electron');

/**
 * The IPC security gate.
 *
 * Every protected channel (one with `authorize`, or `session: true`) must carry
 * the session token. The gate resolves the signed-in user, their permissions,
 * and their workstation from the database, then:
 *
 *   1. replaces `payload.actor` with that trusted actor, so every permission
 *      check sees the user's real permissions rather than a list the screen
 *      sent;
 *   2. overwrites the identity fields anywhere in the payload -- the caller,
 *      their session, their workstation, where the work happens, and which
 *      location's data it touches -- with the session's own values;
 *   3. runs the handler inside the request context, so services can read the
 *      trusted origin without trusting their input.
 *
 * `macCode` and `txnDate` are deliberately left alone: screens send them as
 * search filters (another terminal at the same location, a past date). No write
 * trusts them; writes take their origin from the request context.
 */

let security = null;

function configureIpcSecurity({ sessionContextService, requestContext }) {
  if (!sessionContextService || !requestContext) throw new Error('IPC security needs the session context service and request context.');
  security = { sessionContextService, requestContext };
}

// Channels where these fields name someone or somewhere other than the caller.
const TARGETS_ANOTHER_USER = /^(users|roles)\./;
const TARGETS_ANOTHER_PLACE = /^(workstations|locations)\./;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !(value instanceof Date) && !Buffer.isBuffer(value);
}

function bindIdentity(channel, payload, context) {
  const ws = context.workstation;
  const actor = { id: String(context.user.id), permissions: context.permissions.slice() };
  const bindUser = !TARGETS_ANOTHER_USER.test(channel);
  const bindPlace = !TARGETS_ANOTHER_PLACE.test(channel);

  const visit = (node, depth) => {
    if (depth > 8) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (!isPlainObject(node)) return;
    for (const key of Object.keys(node)) {
      if (key === 'actor') { node.actor = { ...actor }; continue; }
      if (key === 'userId' && bindUser) { node.userId = context.user.id; continue; }
      if (bindPlace) {
        // Without an open workstation these are cleared rather than trusted,
        // so any service that needs a location refuses instead of using one
        // the screen chose.
        if (key === 'origin') { node.origin = ws ? { locCode: ws.locCode, macCode: ws.macCode, txnDate: ws.businessDate } : null; continue; }
        if (key === 'locCode' || key === 'locationCode') { node[key] = ws ? ws.locCode : null; continue; }
        if (key === 'sessionId' || key === 'workstationSessionId') { node[key] = ws ? ws.workstationSessionId : null; continue; }
        if (key === 'workstationId') { node.workstationId = ws ? ws.workstationId : null; continue; }
      }
      visit(node[key], depth + 1);
    }
  };

  const bound = isPlainObject(payload) ? payload : {};
  delete bound.__token;
  visit(bound, 0);
  bound.actor = { ...actor };
  if (isPlainObject(bound.context)) bound.context.actor = { ...actor };
  return bound;
}

// The preload attaches the session token to every request as `__token`, so no
// screen can forget it. `token` is accepted for the auth channels that name it.
function tokenOf(payload) {
  return payload?.__token || payload?.context?.actor?.token || payload?.actor?.token || payload?.token || null;
}

function wrapIpcHandler(channel, handler, options = {}) {
  const protectedChannel = typeof options.authorize === 'function' || options.session === true;
  ipcMain.handle(channel, async (_event, rawPayload) => {
    try {
      let payload = rawPayload;
      let context = null;
      if (protectedChannel) {
        if (!security) throw new Error('IPC security is not configured.');
        context = await security.sessionContextService.resolve(tokenOf(rawPayload));
        payload = bindIdentity(channel, rawPayload, context);
      }
      if (typeof options.authorize === 'function') {
        await options.authorize(payload);
      }
      if (!protectedChannel && payload && typeof payload === 'object') delete payload.__token;
      let data;
      if (context) data = await security.requestContext.run(context, () => handler(payload, context));
      else if (security) data = await security.requestContext.runAnonymous(() => handler(payload));
      else data = await handler(payload);
      return {
        success: true,
        data
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

module.exports = {
  wrapIpcHandler,
  configureIpcSecurity,
  // Exported for the verification script; the running app only uses the gate.
  bindIdentity
};
