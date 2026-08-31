const { ipcMain } = require('electron');

function wrapIpcHandler(channel, handler, options = {}) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      if (typeof options.authorize === 'function') {
        await options.authorize(payload);
      }
      const data = await handler(payload);
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
  wrapIpcHandler
};
