const test = require('node:test');
const assert = require('node:assert/strict');
const { createFieldInboxService, utcDayRange } = require('./field-inbox.service');

test('utcDayRange sends the selected day as an exact ISO since/until range', () => {
  assert.deepEqual(utcDayRange('2026-08-17'), {
    since: '2026-08-17T00:00:00.000Z',
    until: '2026-08-18T00:00:00.000Z'
  });
});

test('listRecords authenticates once and merges local resolution state', async () => {
  const calls = [];
  const repository = {
    getConfiguration: async () => ({ host_id: 'TH-9926122E', api_key_ciphertext: 'cipher' }),
    listResolved: async (hostId, recordIds) => {
      assert.equal(hostId, 'TH-9926122E');
      assert.deepEqual(recordIds, ['11']);
      return [{ record_id: '11', resolved_at: '2026-08-17T13:00:00.000Z', resolved_by: 1 }];
    }
  };
  const service = createFieldInboxService({
    fieldInboxRepository: repository,
    secretProtector: { encrypt: (value) => value, decrypt: () => 'secret-key' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          hostId: 'TH-9926122E',
          cursor: 'created_at',
          range: { since: '2026-08-17T00:00:00.000Z', until: '2026-08-18T00:00:00.000Z' },
          records: [{
            id: '11', client_record_id: 'client-11', type: 'cash', direction: 'incoming',
            amount: '50.00', item: null, qty: null, unit: null, note: 'test',
            created_at: '2026-08-17T11:24:34.752Z', received_at: '2026-08-17T11:40:00.775Z',
            media: [], device: { id: 'device-1', nickname: 'Field phone', model: 'Pixel 6' }
          }]
        })
      };
    }
  });

  const result = await service.listRecords({ date: '2026-08-17' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /since=2026-08-17T00%3A00%3A00\.000Z/);
  assert.match(calls[0].url, /until=2026-08-18T00%3A00%3A00\.000Z/);
  assert.equal(calls[0].options.headers['X-Host-ID'], 'TH-9926122E');
  assert.equal(calls[0].options.headers['X-API-Key'], 'secret-key');
  assert.equal(result.records[0].amount, 50);
  assert.equal(result.records[0].resolved, true);
  assert.equal(result.records[0].device.nickname, 'Field phone');
});

test('configuration snapshot never exposes the stored API key', async () => {
  const service = createFieldInboxService({
    fieldInboxRepository: {
      getConfiguration: async () => ({ host_id: 'TH-1', api_key_ciphertext: 'encrypted-secret' })
    },
    secretProtector: { encrypt: (value) => value, decrypt: (value) => value },
    fetchImpl: async () => { throw new Error('not called'); }
  });
  const result = await service.getConfiguration();
  assert.deepEqual(Object.keys(result).sort(), ['apiBaseUrl', 'configured', 'hasApiKey', 'hostId', 'updatedAt']);
  assert.equal(JSON.stringify(result).includes('encrypted-secret'), false);
});

test('identifies the registered POS node when requesting routed field records', async () => {
  let requestHeaders;
  const service = createFieldInboxService({
    fieldInboxRepository: {
      getConfiguration: async () => ({ host_id: 'TH-TEST', api_key_ciphertext: 'cipher' }),
      listResolved: async () => []
    },
    cloudSyncRepository: {
      ensureConfiguration: async () => ({ node_id: 'node-7', registered_host_id: 'TH-TEST' })
    },
    secretProtector: { decrypt: () => 'secret' },
    fetchImpl: async (_url, options) => {
      requestHeaders = options.headers;
      return { ok: true, status: 200, json: async () => ({ hostId: 'TH-TEST', cursor: 'created_at', range: {}, records: [] }) };
    }
  });
  await service.listRecords({ date: '2026-08-17' });
  assert.equal(requestHeaders['X-POS-Node-ID'], 'node-7');
});
