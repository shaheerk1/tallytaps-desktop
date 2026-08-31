const crypto = require('crypto');

const DEFAULT_API_BASE_URL = 'https://yolo.web.lk/postfix-endpoint-tally/api/v1';

function createCloudSyncService({ repository, secretProtector, fetchImpl = global.fetch, apiBaseUrl = DEFAULT_API_BASE_URL }) {
  if (!repository) throw new Error('Cloud sync service requires a repository.');
  if (!secretProtector) throw new Error('Cloud sync service requires secure credential storage.');
  if (typeof fetchImpl !== 'function') throw new Error('Cloud sync service requires fetch support.');
  let running = null;
  let failureCount = 0;

  async function getConfiguration() {
    const { config, queue } = await repository.status();
    return snapshot(config, queue);
  }

  async function saveConfiguration(input = {}) {
    const intervalMinutes = boundedInt(input.intervalMinutes, 1, 1440, 15);
    const batchSize = boundedInt(input.batchSize, 10, 500, 100);
    const maxBatchesPerRun = boundedInt(input.maxBatchesPerRun, 1, 20, 4);
    const nickname = optionalText(input.nickname, 120);
    const config = await repository.saveConfiguration({ enabled: input.enabled === true, intervalMinutes, batchSize, maxBatchesPerRun, nickname });
    const status = await repository.status();
    return snapshot(config, status.queue);
  }

  async function runNow({ force = false } = {}) {
    if (running) return running;
    running = execute(force).finally(() => { running = null; });
    return running;
  }

  async function listMobileBills({ since, until }) {
    const config = await repository.ensureConfiguration();
    if (!config.node_id || !config.node_key_ciphertext) throw new Error('Run POS Cloud Backup once to register this POS inbox.');
    const query = new URLSearchParams({ since, ...(until ? { until } : {}) });
    const response = await request(`${apiBaseUrl}/pos-sync/mobile-bills?${query}`, { method: 'GET', headers: nodeHeaders(config) }, 20_000);
    const body = await responseJson(response);
    if (!response.ok || !Array.isArray(body.bills)) throw new Error(apiError(body, response.status, 'Could not load mobile bills.'));
    return body;
  }

  async function setMobileBillStatus({ billId, status }) {
    const config = await repository.ensureConfiguration();
    if (!config.node_id || !config.node_key_ciphertext) throw new Error('This POS inbox is not registered.');
    if (!['viewed', 'printed'].includes(status)) throw new Error('Invalid mobile bill status.');
    const response = await request(`${apiBaseUrl}/pos-sync/mobile-bills/${encodeURIComponent(String(billId))}/status`, {
      method: 'POST', headers: nodeHeaders(config), body: JSON.stringify({ status }),
    }, 15_000);
    const body = await responseJson(response);
    if (!response.ok) throw new Error(apiError(body, response.status, 'Could not update mobile bill status.'));
    return body;
  }

  async function execute(force) {
    let config = await repository.ensureConfiguration();
    if (!force && !config.enabled) return { skipped: true, reason: 'disabled', ...(await getConfiguration()) };
    if (!config.host_id || !config.api_key_ciphertext) throw new Error('Save the Host ID and API key in Field Transaction Inbox settings before enabling cloud backup.');
    try {
      config = await ensureNode(config);
      await repository.collectChanges(Math.max(500, Number(config.batch_size) * Number(config.max_batches_per_run)));
      let uploaded = 0;
      for (let index = 0; index < Number(config.max_batches_per_run); index += 1) {
        const events = await repository.pendingBatch(Number(config.batch_size));
        if (!events.length) break;
        const result = await uploadBatch(config, events);
        if (result.resyncRequired) {
          await repository.resetReplicaState();
          throw new Error('The cloud archive was reset. Local records were queued again for a clean resynchronization.');
        }
        await repository.removeThrough(result.lastSequence);
        uploaded += result.accepted;
      }
      const catalogPublished = await publishCatalogIfChanged(config);
      failureCount = 0;
      await repository.setAttempt({ success: true });
      return { skipped: false, uploaded, catalogPublished, ...(await getConfiguration()) };
    } catch (error) {
      failureCount += 1;
      const retryMinutes = Math.min(360, Math.max(1, 2 ** Math.min(failureCount, 8)));
      const retryAt = new Date(Date.now() + retryMinutes * 60_000);
      await repository.setAttempt({ success: false, error: safeError(error), retryAt });
      throw error;
    }
  }

  async function ensureNode(config) {
    if (config.registered_host_id && config.registered_host_id !== config.host_id) {
      await repository.clearNode();
      await repository.resetReplicaState();
      config = await repository.ensureConfiguration();
    }
    if (config.node_id && config.node_key_ciphertext) return config;
    const response = await request(`${apiBaseUrl}/pos-sync/nodes/register`, {
      method: 'POST', headers: hostHeaders(config),
      body: JSON.stringify({ installationId: config.installation_id, nickname: config.node_nickname || 'DDEC POS', appVersion: require('../../../package.json').version }),
    }, 20_000);
    const body = await responseJson(response);
    if (!response.ok || !body.nodeId || !body.nodeKey) throw new Error(apiError(body, response.status, 'POS node registration failed.'));
    if (Number(body.lastSequence || 0) === 0) await repository.resetReplicaState();
    await repository.saveNode({ hostId: config.host_id, nodeId: body.nodeId, nodeKeyCiphertext: secretProtector.encrypt(body.nodeKey) });
    return repository.ensureConfiguration();
  }

  async function uploadBatch(config, events) {
    const response = await request(`${apiBaseUrl}/pos-sync/batches`, {
      method: 'POST', headers: nodeHeaders(config), body: JSON.stringify({ batchId: crypto.randomUUID(), events }),
    }, 30_000);
    const body = await responseJson(response);
    if (response.status === 409 && Number.isSafeInteger(Number(body.expectedSequence))) {
      const expected = Number(body.expectedSequence);
      if (expected > events[0].sequence) {
        await repository.removeThrough(expected - 1);
        return { accepted: 0, lastSequence: expected - 1 };
      }
      return { resyncRequired: true, accepted: 0, lastSequence: 0 };
    }
    if (!response.ok) {
      await repository.markBatchAttempt(events.map((event) => event.sequence), apiError(body, response.status, 'Archive upload failed.'));
      throw new Error(apiError(body, response.status, 'Archive upload failed.'));
    }
    return { accepted: Number(body.accepted || events.length), lastSequence: Number(body.lastSequence || events.at(-1).sequence) };
  }

  async function publishCatalogIfChanged(config) {
    const items = await repository.listProducts();
    if (items.length > 1000) throw new Error('The current cloud catalog limit is 1000 products. Increase the server limit before syncing this catalog.');
    const hash = crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
    if (hash === config.last_catalog_hash) return false;
    const response = await request(`${apiBaseUrl}/pos-sync/catalog/snapshots`, {
      method: 'POST', headers: nodeHeaders(config), body: JSON.stringify({ items }),
    }, 45_000);
    const body = await responseJson(response);
    if (!response.ok) throw new Error(apiError(body, response.status, 'Catalog upload failed.'));
    await repository.saveCatalogHash(hash);
    return true;
  }

  function hostHeaders(config) {
    return { 'Content-Type': 'application/json', 'X-Host-ID': config.host_id, 'X-API-Key': secretProtector.decrypt(config.api_key_ciphertext) };
  }
  function nodeHeaders(config) {
    return { 'Content-Type': 'application/json', 'X-POS-Node-ID': config.node_id, 'X-POS-Node-Key': secretProtector.decrypt(config.node_key_ciphertext) };
  }
  async function request(url, options, timeoutMs) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetchImpl(url, { ...options, signal: controller.signal }); }
    catch (error) { if (error?.name === 'AbortError') throw new Error('Cloud synchronization timed out.'); throw error; }
    finally { clearTimeout(timer); }
  }

  return { getConfiguration,saveConfiguration,runNow,listMobileBills,setMobileBillStatus };
}

function snapshot(config, queue = {}) {
  return { configured: !!(config?.host_id && config?.api_key_ciphertext), enabled: !!config?.enabled,
    intervalMinutes: Number(config?.interval_minutes || 15), batchSize: Number(config?.batch_size || 100),
    maxBatchesPerRun: Number(config?.max_batches_per_run || 4), nickname: config?.node_nickname || '',
    nodeId: config?.node_id || null, pendingCount: Number(queue?.pending_count || 0),
    lastSuccessAt: config?.last_success_at || null, lastAttemptAt: config?.last_attempt_at || null,
    lastError: config?.last_error || null, nextRetryAt: config?.next_retry_at || null, apiBaseUrl: DEFAULT_API_BASE_URL };
}
function boundedInt(value,min,max,fallback) { const n=Number(value); if (!Number.isInteger(n)) return fallback; return Math.max(min,Math.min(max,n)); }
function optionalText(value,max) { const text=String(value || '').trim(); return text ? text.slice(0,max) : null; }
async function responseJson(response) { try { return await response.json(); } catch { return {}; } }
function apiError(body,status,fallback) { return String(body?.error || body?.message || `${fallback} (HTTP ${status})`); }
function safeError(error) { return String(error?.message || error || 'Unknown synchronization error').slice(0,4000); }

module.exports = { DEFAULT_API_BASE_URL,createCloudSyncService };
