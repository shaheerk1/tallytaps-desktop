function createCloudSyncScheduler({ service, logger = console }) {
  let timer = null;
  let stopped = false;

  async function schedule(delayMs = 15_000) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, Math.max(1_000, delayMs));
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    let nextMinutes = 15;
    try {
      const config = await service.getConfiguration();
      nextMinutes = config.intervalMinutes;
      if (config.enabled && (!config.nextRetryAt || new Date(config.nextRetryAt).getTime() <= Date.now())) await service.runNow();
    } catch (error) {
      logger.warn('[cloud-sync] Background synchronization failed:', error?.message || error);
    } finally {
      schedule(nextMinutes * 60_000);
    }
  }

  function start() { stopped = false; schedule(); }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }
  function refresh() { schedule(1_000); }
  return { start,stop,refresh };
}

module.exports = { createCloudSyncScheduler };
