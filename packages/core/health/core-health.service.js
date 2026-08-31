function createCoreHealthService() {
  return {
    check() {
      return {
        app: 'POS Platform',
        status: 'ok',
        timestamp: new Date().toISOString(),
        platform: process.platform,
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node
      };
    }
  };
}

module.exports = {
  createCoreHealthService
};
