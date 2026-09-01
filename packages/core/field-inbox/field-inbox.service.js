const API_BASE_URL = 'https://yolo.web.lk/postfix-endpoint-tally/api/v1';
const LIST_TIMEOUT_MS = 15000;
const MEDIA_TIMEOUT_MS = 30000;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;

function createFieldInboxService({ fieldInboxRepository, cloudSyncRepository = null, secretProtector, fetchImpl = global.fetch }) {
  if (!fieldInboxRepository) throw new Error('Field inbox service requires fieldInboxRepository.');
  if (cloudSyncRepository && typeof cloudSyncRepository.ensureConfiguration !== 'function') {
    throw new Error('Field inbox service requires a valid cloud sync repository.');
  }
  if (!secretProtector) throw new Error('Field inbox service requires secretProtector.');
  if (typeof fetchImpl !== 'function') throw new Error('Field inbox service requires fetch support.');

  async function getConfiguration() {
    const row = await fieldInboxRepository.getConfiguration();
    return configurationSnapshot(row);
  }

  async function saveConfiguration(payload = {}) {
    if (payload.clearApiKey) {
      await fieldInboxRepository.clearConfiguration();
      return configurationSnapshot(null);
    }

    const hostId = normalizeRequired(payload.hostId, 'Host ID', 120);
    const current = await fieldInboxRepository.getConfiguration();
    let apiKeyCiphertext = current?.api_key_ciphertext || '';

    const apiKey = String(payload.apiKey || '').trim();
    if (apiKey) apiKeyCiphertext = secretProtector.encrypt(apiKey);
    if (!apiKeyCiphertext) throw new Error('API key is required.');

    const saved = await fieldInboxRepository.saveConfiguration({ hostId, apiKeyCiphertext });
    return configurationSnapshot(saved);
  }

  async function testConnection(payload = {}) {
    const date = normalizeDate(payload.date || new Date().toISOString().slice(0, 10));
    const result = await fetchRecordsForDate(date);
    return {
      connected: true,
      hostId: result.hostId,
      recordCount: result.records.length,
      range: result.range
    };
  }

  async function listRecords(payload = {}) {
    const date = normalizeDate(payload.date);
    const result = await fetchRecordsForDate(date);
    const recordIds = result.records.map((record) => record.id);
    const resolvedRows = await fieldInboxRepository.listResolved(result.hostId, recordIds);
    const resolvedById = new Map(resolvedRows.map((row) => [String(row.record_id), row]));

    const records = result.records.map((record) => {
      const state = resolvedById.get(record.id);
      return {
        ...record,
        resolved: !!state,
        resolvedAt: state?.resolved_at || null,
        resolvedBy: state?.resolved_by == null ? null : Number(state.resolved_by)
      };
    });

    return { hostId: result.hostId, cursor: result.cursor, range: result.range, records };
  }

  async function setResolved(payload = {}) {
    const config = await requireConfiguration();
    const recordId = normalizeRequired(payload.recordId, 'Record ID', 120);
    const clientRecordId = optionalText(payload.clientRecordId, 180);
    const userId = Number(payload.userId);
    return fieldInboxRepository.setResolved({
      hostId: config.host_id,
      recordId,
      clientRecordId,
      userId: Number.isInteger(userId) && userId > 0 ? userId : null,
      resolved: payload.resolved !== false
    });
  }

  async function getMedia(payload = {}) {
    const mediaId = normalizeRequired(payload.mediaId, 'Media ID', 128);
    if (!/^[A-Za-z0-9-]+$/.test(mediaId)) throw new Error('Invalid media ID.');
    const config = await requireConfiguration();
    const response = await authenticatedFetch(
      `${API_BASE_URL}/media/${encodeURIComponent(mediaId)}`,
      config,
      MEDIA_TIMEOUT_MS
    );
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/') && !contentType.startsWith('audio/')) {
      throw new Error('The server returned an unsupported media type.');
    }
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_MEDIA_BYTES) throw new Error('Media is larger than the 12 MB viewing limit.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_MEDIA_BYTES) throw new Error('Media is larger than the 12 MB viewing limit.');
    return { mediaId, contentType, sizeBytes: buffer.length, dataBase64: buffer.toString('base64') };
  }

  async function fetchRecordsForDate(date) {
    const config = await requireConfiguration();
    const { since, until } = utcDayRange(date);
    const query = new URLSearchParams({ since, until });
    const response = await authenticatedFetch(
      `${API_BASE_URL}/pos/records/by-created-at?${query.toString()}`,
      config,
      LIST_TIMEOUT_MS
    );
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error('The transaction server returned an invalid response.');
    }
    if (!body || !Array.isArray(body.records)) throw new Error('The transaction server response has no records list.');
    const responseHostId = String(body.hostId || config.host_id).trim();
    if (responseHostId && responseHostId !== config.host_id) {
      throw new Error('The transaction server returned records for a different host.');
    }
    return {
      hostId: config.host_id,
      cursor: String(body.cursor || 'created_at'),
      range: {
        since: String(body.range?.since || since),
        until: String(body.range?.until || until)
      },
      records: body.records.map(normalizeRecord).filter(Boolean)
    };
  }

  async function authenticatedFetch(url, config, timeoutMs) {
    const apiKey = secretProtector.decrypt(config.api_key_ciphertext);
    const headers = { 'X-Host-ID': config.host_id, 'X-API-Key': apiKey };
    if (cloudSyncRepository) {
      const cloud = await cloudSyncRepository.ensureConfiguration();
      if (cloud?.node_id && cloud?.registered_host_id === config.host_id) headers['X-POS-Node-ID'] = cloud.node_id;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('The Host ID or API key was rejected by the transaction server.');
        }
        throw new Error(`Transaction server request failed (${response.status}).`);
      }
      return response;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Transaction server request timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function requireConfiguration() {
    const row = await fieldInboxRepository.getConfiguration();
    if (!row?.host_id || !row?.api_key_ciphertext) {
      throw new Error('Configure the Field Transaction Inbox in Settings first.');
    }
    return row;
  }

  return { getConfiguration, saveConfiguration, testConnection, listRecords, setResolved, getMedia };
}

function configurationSnapshot(row) {
  return {
    configured: !!(row?.host_id && row?.api_key_ciphertext),
    hostId: String(row?.host_id || ''),
    hasApiKey: !!row?.api_key_ciphertext,
    updatedAt: row?.updated_at || null,
    apiBaseUrl: API_BASE_URL
  };
}

function normalizeRecord(value) {
  if (!value || value.id === null || value.id === undefined) return null;
  const device = value.device || {};
  return {
    id: String(value.id),
    clientRecordId: optionalText(value.client_record_id, 180),
    type: optionalText(value.type, 60) || 'unknown',
    direction: optionalText(value.direction, 60) || 'unknown',
    amount: finiteNumber(value.amount),
    item: optionalText(value.item, 255),
    qty: nullableNumber(value.qty),
    unit: optionalText(value.unit, 60),
    note: optionalText(value.note, 4000),
    createdAt: validIso(value.created_at),
    receivedAt: validIso(value.received_at),
    media: Array.isArray(value.media) ? value.media.map(normalizeMedia).filter(Boolean) : [],
    device: {
      id: optionalText(device.id, 180),
      name: optionalText(device.name, 180),
      model: optionalText(device.model, 180),
      codeName: optionalText(device.codeName, 180),
      nickname: optionalText(device.nickname, 180),
      platform: optionalText(device.platform, 80),
      appVersion: optionalText(device.appVersion, 80)
    }
  };
}

function normalizeMedia(value) {
  if (!value?.id) return null;
  return {
    id: String(value.id),
    type: optionalText(value.type, 40) || 'unknown',
    sizeBytes: Math.max(0, finiteNumber(value.sizeBytes)),
    contentType: optionalText(value.contentType, 120) || 'application/octet-stream'
  };
}

function utcDayRange(date) {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { since: start.toISOString(), until: end.toISOString() };
}

function normalizeDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A valid date is required.');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('A valid date is required.');
  }
  return date;
}

function normalizeRequired(value, label, maxLength) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) throw new Error(`${label} is too long.`);
  return text;
}

function optionalText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = {
  API_BASE_URL,
  createFieldInboxService,
  utcDayRange,
  normalizeRecord
};
