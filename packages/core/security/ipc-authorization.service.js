function createIpcAuthorizationService() {
  function getActor(payload) {
    return payload?.context?.actor || payload?.actor || null;
  }

  function requirePermission(requiredPermission) {
    return async (payload) => {
      const actor = getActor(payload);
      if (!actor) {
        throw new Error(`Missing actor context for permission ${requiredPermission}.`);
      }

      const permissions = actor.permissions || [];
      if (!permissions.includes(requiredPermission)) {
        throw new Error(`Permission denied: ${requiredPermission}`);
      }
    };
  }

  return {
    requirePermission
  };
}

module.exports = {
  createIpcAuthorizationService
};
