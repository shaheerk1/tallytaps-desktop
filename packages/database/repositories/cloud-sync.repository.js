const crypto = require('crypto');

const STREAMS = [
  { entity: 'invoice', table: 'invoices', where: "t.status <> 'draft'" },
  { entity: 'invoice_item', table: 'invoice_items', join: 'JOIN invoices p ON p.id=t.invoice_id', where: "p.status <> 'draft'" },
  { entity: 'payment', table: 'payments', join: 'JOIN invoices p ON p.id=t.invoice_id', where: "p.status <> 'draft'" },
  { entity: 'refund', table: 'refunds' },
  { entity: 'refund_item', table: 'refund_items' },
  { entity: 'refund_payment', table: 'refund_payments' },
  { entity: 'refund_audit_event', table: 'refund_audit_events' },
  { entity: 'cash_shift', table: 'cash_shifts' },
  { entity: 'cash_count', table: 'cash_counts' },
  { entity: 'cash_count_line', table: 'cash_count_lines' },
  { entity: 'cash_movement', table: 'cash_movements' },
  { entity: 'cash_shift_report', table: 'cash_shift_reports' },
  { entity: 'cash_shift_report_print', table: 'cash_shift_report_prints' },
  { entity: 'stock_movement', table: 'stock_movements' },
  { entity: 'inventory_lot', table: 'inventory_lots' },
  { entity: 'inventory_measurement', table: 'inventory_measurements' },
  { entity: 'inventory_stock_count', table: 'inventory_stock_counts', where: "t.status='finalized'" },
  { entity: 'inventory_stock_count_line', table: 'inventory_stock_count_lines', join: 'JOIN inventory_stock_counts p ON p.id=t.stock_count_id', where: "p.status='finalized'" },
  { entity: 'lot_sale_allocation', table: 'lot_sale_allocations' },
  { entity: 'party', table: 'parties' },
  { entity: 'party_identifier', table: 'party_identifiers' },
  { entity: 'customer_account', table: 'customer_accounts' },
  { entity: 'customer_receivable_entry', table: 'customer_receivable_entries' },
  { entity: 'invoice_customer_assignment_event', table: 'invoice_customer_assignment_events' },
  { entity: 'cheque', table: 'cheques' },
  { entity: 'cheque_status_event', table: 'cheque_status_events' },
  { entity: 'issued_cheque', table: 'issued_cheques' },
  { entity: 'issued_cheque_status_event', table: 'issued_cheque_status_events' },
  { entity: 'business_bank_account', table: 'business_bank_accounts' },
  { entity: 'business_day', table: 'business_days' },
  { entity: 'business_day_event', table: 'business_day_events' },
  { entity: 'goods_receipt', table: 'goods_receipts', where: "t.status IN ('finalized','corrected')" },
  { entity: 'goods_receipt_line', table: 'goods_receipt_lines', join: 'JOIN goods_receipts p ON p.id=t.goods_receipt_id', where: "p.status IN ('finalized','corrected')" },
];

function createCloudSyncRepository({ database }) {
  if (!database) throw new Error('Cloud sync repository requires a database instance.');

  async function ensureConfiguration() {
    return database.withConnection(async (connection) => {
      await connection.execute(`INSERT IGNORE INTO pos_cloud_sync_configuration (id,installation_id) VALUES (1,?)`, [crypto.randomUUID()]);
      const [rows] = await connection.execute(`SELECT c.*, f.host_id, f.api_key_ciphertext
        FROM pos_cloud_sync_configuration c LEFT JOIN field_inbox_configuration f ON f.id=1 WHERE c.id=1`);
      return rows[0];
    });
  }

  async function saveConfiguration({ enabled, intervalMinutes, batchSize, maxBatchesPerRun, nickname }) {
    await ensureConfiguration();
    return database.withConnection(async (connection) => {
      await connection.execute(`UPDATE pos_cloud_sync_configuration SET enabled=?,interval_minutes=?,batch_size=?,max_batches_per_run=?,node_nickname=? WHERE id=1`,
        [enabled ? 1 : 0, intervalMinutes, batchSize, maxBatchesPerRun, nickname || null]);
      return ensureConfiguration();
    });
  }

  async function saveNode({ hostId, nodeId, nodeKeyCiphertext }) {
    return database.withConnection(async (connection) => {
      await connection.execute(`UPDATE pos_cloud_sync_configuration SET registered_host_id=?,node_id=?,node_key_ciphertext=? WHERE id=1`, [hostId,nodeId,nodeKeyCiphertext]);
    });
  }

  async function clearNode() {
    return database.withConnection(async (connection) => connection.execute(`UPDATE pos_cloud_sync_configuration SET registered_host_id=NULL,node_id=NULL,node_key_ciphertext=NULL WHERE id=1`));
  }

  async function resetReplicaState() {
    return database.withConnection(async (connection) => {
      await connection.query('DELETE FROM pos_cloud_sync_outbox; DELETE FROM pos_cloud_sync_cursors; ALTER TABLE pos_cloud_sync_outbox AUTO_INCREMENT=1; UPDATE pos_cloud_sync_configuration SET last_catalog_hash=NULL WHERE id=1');
    });
  }

  async function collectChanges(maxRecords = 500) {
    let remaining = Math.max(1, Math.min(2000, Number(maxRecords) || 500));
    let queued = 0;
    for (const stream of STREAMS) {
      if (remaining <= 0) break;
      const count = await collectStream(stream, Math.min(100, remaining));
      queued += count;
      remaining -= count;
    }
    return queued;
  }

  async function collectStream(stream, limit) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const [cursorRows] = await connection.execute(`SELECT cursor_at,cursor_id FROM pos_cloud_sync_cursors WHERE entity_type=? FOR UPDATE`, [stream.entity]);
        const cursorAt = cursorRows[0]?.cursor_at || new Date(0);
        const cursorId = Number(cursorRows[0]?.cursor_id || 0);
        const filters = [stream.where, `(t.cloud_sync_updated_at > ? OR (t.cloud_sync_updated_at = ? AND t.id > ?))`].filter(Boolean).join(' AND ');
        const [rows] = await connection.execute(`SELECT t.* FROM ${stream.table} t ${stream.join || ''} WHERE ${filters} ORDER BY t.cloud_sync_updated_at,t.id LIMIT ?`,
          [cursorAt,cursorAt,cursorId,limit]);
        for (const source of rows) {
          const payload = serializableRow(source);
          const sourceUpdatedAt = source.cloud_sync_updated_at;
          delete payload.cloud_sync_updated_at;
          await connection.execute(`INSERT INTO pos_cloud_sync_outbox
            (entity_type,source_key,loc_code,mac_code,payload,source_created_at,source_updated_at)
            VALUES (?,?,?,?,CAST(? AS JSON),?,?)`, [stream.entity,String(source.id),originValue(source,'loc_code'),originValue(source,'mac_code'),
            JSON.stringify(payload),source.created_at || null,sourceUpdatedAt]);
        }
        if (rows.length) {
          const last = rows.at(-1);
          await connection.execute(`INSERT INTO pos_cloud_sync_cursors (entity_type,cursor_at,cursor_id) VALUES (?,?,?)
            ON DUPLICATE KEY UPDATE cursor_at=VALUES(cursor_at),cursor_id=VALUES(cursor_id)`, [stream.entity,last.cloud_sync_updated_at,last.id]);
        }
        await connection.commit();
        return rows.length;
      } catch (error) { await connection.rollback(); throw error; }
    });
  }

  async function pendingBatch(limit) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(`SELECT * FROM pos_cloud_sync_outbox ORDER BY sequence LIMIT ?`, [limit]);
      return rows.map((row) => ({ sequence: Number(row.sequence), entityType: row.entity_type, sourceKey: row.source_key,
        locCode: row.loc_code, macCode: row.mac_code, operation: row.operation, schemaVersion: 1,
        sourceCreatedAt: iso(row.source_created_at), sourceUpdatedAt: iso(row.source_updated_at), payload: json(row.payload) }));
    });
  }

  async function markBatchAttempt(sequences, error = null) {
    if (!sequences.length) return;
    const placeholders = sequences.map(() => '?').join(',');
    return database.withConnection(async (connection) => connection.execute(`UPDATE pos_cloud_sync_outbox SET attempt_count=attempt_count+1,last_attempt_at=NOW(3),last_error=? WHERE sequence IN (${placeholders})`, [error,...sequences]));
  }

  async function removeThrough(sequence) {
    return database.withConnection(async (connection) => connection.execute(`DELETE FROM pos_cloud_sync_outbox WHERE sequence <= ?`, [sequence]));
  }

  async function listProducts() {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(`SELECT * FROM products ORDER BY id LIMIT 1001`);
      return rows.map((row) => {
        const payload = serializableRow(row); delete payload.cloud_sync_updated_at;
        return { sourceProductKey: String(row.id), name: row.name, sku: row.sku, barcode: row.barcode, category: row.category,
          unit: row.unit, unitPrice: Number(row.unit_price || 0), isActive: !!row.is_active, sourceUpdatedAt: iso(row.cloud_sync_updated_at), ...payload };
      });
    });
  }

  async function saveCatalogHash(hash) {
    return database.withConnection(async (connection) => connection.execute('UPDATE pos_cloud_sync_configuration SET last_catalog_hash=? WHERE id=1', [hash]));
  }

  async function setAttempt({ success, error = null, retryAt = null }) {
    return database.withConnection(async (connection) => connection.execute(`UPDATE pos_cloud_sync_configuration SET last_attempt_at=NOW(3),
      last_success_at=IF(?,NOW(3),last_success_at),last_error=?,next_retry_at=? WHERE id=1`, [success ? 1 : 0,error,retryAt]));
  }

  async function status() {
    const config = await ensureConfiguration();
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute('SELECT COUNT(*) pending_count,MIN(sequence) first_sequence,MAX(sequence) last_sequence FROM pos_cloud_sync_outbox');
      return { config, queue: rows[0] };
    });
  }

  return { ensureConfiguration,saveConfiguration,saveNode,clearNode,resetReplicaState,collectChanges,pendingBatch,markBatchAttempt,removeThrough,
    listProducts,saveCatalogHash,setAttempt,status };
}

function serializableRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key,value]) => [key, value instanceof Date ? value.toISOString() : value]));
}
function originValue(row, key) { const value=row[key]; return value == null || value === '' ? null : String(value); }
function iso(value) { if (!value) return null; const date=value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function json(value) { if (value == null) return {}; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return {}; } }

module.exports = { STREAMS,createCloudSyncRepository };
