const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloudSyncService } = require('./cloud-sync.service');
const { STREAMS } = require('../../database/repositories/cloud-sync.repository');

test('desktop archive stream definitions exclude held invoices and draft GRNs', () => {
  assert.match(STREAMS.find((stream) => stream.entity === 'invoice').where, /draft/);
  assert.match(STREAMS.find((stream) => stream.entity === 'invoice_item').join, /invoices/);
  assert.match(STREAMS.find((stream) => stream.entity === 'goods_receipt').where, /finalized/);
  assert.equal(STREAMS.some((stream) => stream.entity === 'supplier_payment'), false);
});

test('desktop archive includes lot allocation exceptions and reconciliation events', () => {
  assert.ok(STREAMS.some((stream) => stream.entity === 'inventory_allocation_exception'));
  assert.ok(STREAMS.some((stream) => stream.entity === 'inventory_allocation_event'));
});

test('desktop archive includes the full customer advance audit trail', () => {
  for (const entity of ['customer_advance_receipt', 'customer_advance_payment', 'customer_advance_refund', 'customer_advance_entry', 'invoice_advance_allocation']) {
    assert.ok(STREAMS.some((stream) => stream.entity === entity), `${entity} is missing`);
  }
});

test('manual cloud sync registers a node, uploads ordered changes and publishes a catalog', async () => {
  const config = { installation_id: '734b5e3f-7d4a-4c5f-8df4-f302cf4efce1', host_id: 'TH-TEST', api_key_ciphertext: 'host-key',
    enabled: 0, interval_minutes: 15, batch_size: 100, max_batches_per_run: 4, node_nickname: 'Main', last_catalog_hash: null };
  let queue = [];
  const repository = {
    ensureConfiguration: async () => config,
    status: async () => ({ config, queue: { pending_count: queue.length } }),
    clearNode: async () => {}, resetReplicaState: async () => { queue = []; },
    saveNode: async ({ hostId, nodeId, nodeKeyCiphertext }) => Object.assign(config, { registered_host_id: hostId, node_id: nodeId, node_key_ciphertext: nodeKeyCiphertext }),
    collectChanges: async () => { queue = [{ sequence: 1, entityType: 'invoice', sourceKey: '8', payload: { id: 8, status: 'paid' } }]; return 1; },
    pendingBatch: async () => queue,
    removeThrough: async () => { queue = []; }, markBatchAttempt: async () => {},
    listProducts: async () => [{ sourceProductKey: '1', name: 'Rice', unitPrice: 20, isActive: true }],
    saveCatalogHash: async (hash) => { config.last_catalog_hash = hash; }, setAttempt: async () => {},
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/nodes/register')) return response(201, { nodeId: 'node-1', nodeKey: 'secret', lastSequence: 0 });
    if (url.endsWith('/batches')) return response(201, { accepted: 1, lastSequence: 1 });
    return response(201, { status: 'published' });
  };
  const service = createCloudSyncService({ repository, fetchImpl, secretProtector: { encrypt: (v) => `enc:${v}`, decrypt: (v) => v.replace(/^enc:/, '') }, apiBaseUrl: 'https://sync.test/api/v1' });
  const result = await service.runNow({ force: true });
  assert.equal(result.uploaded, 1);
  assert.equal(result.catalogPublished, true);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].body.events[0].payload.status, 'paid');
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
