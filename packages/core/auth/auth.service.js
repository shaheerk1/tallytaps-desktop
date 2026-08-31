const crypto = require('crypto');

function verifyPassword(plainText, stored) {
  if (!stored || !stored.includes(':')) {
    return false;
  }
  const [salt, hash] = stored.split(':');
  const derived = crypto.scryptSync(plainText, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
}

function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

const SESSION_TTL_HOURS = 12;

function createAuthService({ authRepository, seedAdminUser, seedDefaultSettings }) {
  if (!authRepository) {
    throw new Error('Auth service requires authRepository.');
  }

  let seeded = false;

  async function ensureAdminSeeded() {
    if (seeded) return;
    if (typeof seedAdminUser === 'function') {
      try {
        await seedAdminUser();
      } catch (_err) {
        // Admin may already exist — non-fatal
      }
    }
    if (typeof seedDefaultSettings === 'function') {
      try {
        await seedDefaultSettings();
      } catch (_err) {
        // Settings may already exist — non-fatal
      }
    }
    seeded = true;
  }

  async function login({ username, password }) {
    if (!username || !password) {
      throw new Error('Username and password are required.');
    }

    await ensureAdminSeeded();

    const user = await authRepository.findUserByUsername(username);
    if (!user) {
      throw new Error('Invalid username or password.');
    }

    if (!verifyPassword(password, user.password_hash)) {
      throw new Error('Invalid username or password.');
    }

    const permissions = await authRepository.getUserPermissions(user.id);
    const roles = await authRepository.getUserRoles(user.id);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    await authRepository.createSession(user.id, token, expiresAt);
    await authRepository.updateLastLogin(user.id);

    const previousLoginAt = user.last_login_at || null;

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        email: user.email || null,
        phone: user.phone || null,
        lastLoginAt: previousLoginAt,
        permissions,
        roles: roles.map((r) => ({ key: r.role_key, name: r.role_name }))
      },
      token,
      expiresAt
    };
  }

  async function validateSession(token) {
    if (!token) {
      throw new Error('Token is required.');
    }

    const session = await authRepository.findSessionByToken(token);
    if (!session) {
      throw new Error('Session expired or invalid.');
    }

    if (session.status !== 'active') {
      await authRepository.deleteSession(token);
      throw new Error('User account is disabled.');
    }

    const permissions = await authRepository.getUserPermissions(session.user_id);
    const roles = await authRepository.getUserRoles(session.user_id);

    return {
      user: {
        id: session.user_id,
        username: session.username,
        displayName: session.display_name,
        email: session.email || null,
        phone: session.phone || null,
        lastLoginAt: session.last_login_at || null,
        permissions,
        roles: roles.map((r) => ({ key: r.role_key, name: r.role_name }))
      },
      token: session.token,
      expiresAt: session.expires_at
    };
  }

  async function logout(token) {
    if (token) {
      await authRepository.deleteSession(token);
    }
    return { loggedOut: true };
  }

  async function logoutAll(userId) {
    await authRepository.deleteUserSessions(userId);
    return { loggedOut: true };
  }

  async function cleanupExpiredSessions() {
    return authRepository.deleteExpiredSessions();
  }

  return {
    login,
    validateSession,
    logout,
    logoutAll,
    cleanupExpiredSessions
  };
}

module.exports = {
  createAuthService
};
