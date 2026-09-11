/**
 * Turns a session token into the trusted context of a request.
 *
 * This is the only place that decides who is making a request and which
 * workstation it comes from. The renderer sends its token; everything else --
 * the user, their permissions, the location, the terminal, the business date --
 * is read from the database here, never taken from the request.
 *
 * Contexts are cached for a few seconds because billing calls the main process
 * on every keystroke. Anything that changes a sign-in's identity (login,
 * logout, a changed business date, a closed session) invalidates the cache.
 */
const CACHE_TTL_MS = 3000;

function createSessionContextService({ authRepository }) {
  if (!authRepository) throw new Error('Session context service requires the auth repository.');

  const dateOnly = (value) => value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value || '').slice(0, 10);

  const cache = new Map();

  function invalidate(token) {
    if (token) cache.delete(token);
    else cache.clear();
  }

  async function resolve(token) {
    const key = String(token || '').trim();
    if (!key) throw new Error('Your session has ended. Sign in again.');

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.context;

    const row = await authRepository.findRequestContext(key);
    if (!row) {
      cache.delete(key);
      throw new Error('Your session has ended. Sign in again.');
    }
    if (row.user_status !== 'active') {
      cache.delete(key);
      throw new Error('This user account is disabled.');
    }

    const permissions = await authRepository.getUserPermissions(row.user_id);
    const hasWorkstation = row.workstation_session_id != null
      && row.workstation_status === 'active'
      && row.location_status === 'active';

    const context = {
      token: key,
      user: { id: Number(row.user_id), username: row.username, displayName: row.display_name },
      permissions,
      workstation: hasWorkstation
        ? {
          workstationSessionId: Number(row.workstation_session_id),
          workstationId: Number(row.workstation_id),
          name: row.workstation_name,
          locCode: row.location_code,
          macCode: row.machine_code,
          businessCode: row.business_code,
          businessDate: dateOnly(row.billing_date)
        }
        : null
    };
    cache.set(key, { context, expiresAt: Date.now() + CACHE_TTL_MS });
    return context;
  }

  return { resolve, invalidate };
}

module.exports = { createSessionContextService };
