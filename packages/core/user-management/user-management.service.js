function createUserManagementService({ userManagementRepository }) {
  if (!userManagementRepository) {
    throw new Error('User management service requires userManagementRepository.');
  }

  // ── Users ─────────────────────────────────────────────────

  async function listUsers() {
    return userManagementRepository.listUsers();
  }

  async function getUser(id) {
    const user = await userManagementRepository.findUserById(id);
    if (!user) throw new Error(`User ${id} not found.`);
    return user;
  }

  async function createUser({ username, password, displayName, email, phone, status, roleIds }) {
    if (!username || !username.trim()) throw new Error('Username is required.');
    if (!password || password.length < 4) throw new Error('Password must be at least 4 characters.');
    if (!displayName || !displayName.trim()) throw new Error('Display name is required.');

    return userManagementRepository.createUser({
      username: username.trim(),
      password,
      displayName: displayName.trim(),
      email: email || null,
      phone: phone || null,
      status: status || 'active',
      roleIds: roleIds || []
    });
  }

  async function updateUser(id, { displayName, email, phone, status }) {
    return userManagementRepository.updateUser(id, {
      displayName: displayName || undefined,
      email: email !== undefined ? email : undefined,
      phone: phone !== undefined ? phone : undefined,
      status: status || undefined
    });
  }

  async function updatePassword(id, newPassword) {
    if (!newPassword || newPassword.length < 4) {
      throw new Error('Password must be at least 4 characters.');
    }
    return userManagementRepository.updatePassword(id, newPassword);
  }

  async function deleteUser(id) {
    return userManagementRepository.deleteUser(id);
  }

  async function setUserRoles(userId, roleIds) {
    return userManagementRepository.setUserRoles(userId, roleIds || []);
  }

  // ── Roles ─────────────────────────────────────────────────

  async function listRoles() {
    return userManagementRepository.listRoles();
  }

  async function getRole(id) {
    const role = await userManagementRepository.findRoleById(id);
    if (!role) throw new Error(`Role ${id} not found.`);
    return role;
  }

  async function createRole({ roleKey, name }) {
    if (!roleKey || !roleKey.trim()) throw new Error('Role key is required.');
    if (!name || !name.trim()) throw new Error('Role name is required.');

    const sanitizedKey = roleKey.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (sanitizedKey !== roleKey.trim()) {
      throw new Error('Role key can only contain lowercase letters, numbers, underscores, and hyphens.');
    }

    return userManagementRepository.createRole({
      roleKey: sanitizedKey,
      name: name.trim()
    });
  }

  async function updateRole(id, { name }) {
    return userManagementRepository.updateRole(id, {
      name: name || undefined
    });
  }

  async function deleteRole(id) {
    return userManagementRepository.deleteRole(id);
  }

  async function setRolePermissions(roleId, permissionIds) {
    return userManagementRepository.setRolePermissions(roleId, permissionIds || []);
  }

  // ── Permissions ───────────────────────────────────────────

  async function listPermissions() {
    return userManagementRepository.listPermissions();
  }

  return {
    listUsers,
    getUser,
    createUser,
    updateUser,
    updatePassword,
    deleteUser,
    setUserRoles,
    listRoles,
    getRole,
    createRole,
    updateRole,
    deleteRole,
    setRolePermissions,
    listPermissions
  };
}

module.exports = {
  createUserManagementService
};
