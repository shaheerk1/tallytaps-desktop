function createPriorityListService({ priorityListRepository, userManagementRepository }) {
  if (!priorityListRepository) {
    throw new Error('Priority list service requires priorityListRepository.');
  }
  if (!userManagementRepository) {
    throw new Error('Priority list service requires userManagementRepository.');
  }

  async function listLists() {
    return priorityListRepository.list();
  }

  async function getList(id) {
    return priorityListRepository.findById(id);
  }

  async function createList(payload = {}) {
    const name = String(payload.name || '').trim();
    if (!name) {
      throw new Error('Priority list name is required.');
    }
    return priorityListRepository.create({
      name,
      entries: Array.isArray(payload.entries) ? payload.entries : [],
      isDefault: !!payload.isDefault
    });
  }

  async function updateList(id, payload = {}) {
    const name = payload.name !== undefined ? String(payload.name).trim() : undefined;
    if (name !== undefined && !name) {
      throw new Error('Priority list name is required.');
    }
    return priorityListRepository.update(id, {
      name,
      entries: Array.isArray(payload.entries) ? payload.entries : undefined,
      isDefault: payload.isDefault !== undefined ? !!payload.isDefault : undefined
    });
  }

  async function deleteList(id) {
    const existing = await priorityListRepository.findById(id);
    if (!existing) throw new Error('Priority list not found.');
    if (existing.isDefault) {
      throw new Error('The Default priority list cannot be deleted.');
    }
    return priorityListRepository.deleteById(id);
  }

  async function setDefaultList(id) {
    return priorityListRepository.setDefault(id);
  }

  async function setAssignments(listId, assignments = []) {
    const clean = assignments.filter(
      (a) =>
        a &&
        (a.targetType === 'role' || a.targetType === 'user') &&
        Number.isFinite(Number(a.targetId))
    );
    return priorityListRepository.setAssignments(listId, clean);
  }

  async function resolveForUser(userId) {
    return priorityListRepository.resolveForUser(userId);
  }

  /**
   * Users + roles for the assignment pickers in the settings UI.
   */
  async function listAssignmentTargets() {
    const [users, roles] = await Promise.all([
      userManagementRepository.listUsers(),
      userManagementRepository.listRoles()
    ]);
    return {
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name
      })),
      roles: roles.map((r) => ({
        id: r.id,
        roleKey: r.role_key,
        name: r.name
      }))
    };
  }

  return {
    listLists,
    getList,
    createList,
    updateList,
    deleteList,
    setDefaultList,
    setAssignments,
    resolveForUser,
    listAssignmentTargets
  };
}

module.exports = {
  createPriorityListService
};
