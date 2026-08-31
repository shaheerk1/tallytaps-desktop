function createBillDraftRepository({ database }) {
  if (!database) {
    throw new Error('Bill draft repository requires a database instance.');
  }

  /**
   * Open a new draft for the current billing session.
   * Returns the draft record.
   */
  async function openDraft({ sessionId, receiptNo, locCode, macCode, txnDate, userId }) {
    return database.withConnection(async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO bill_drafts (session_id, receipt_no, loc_code, mac_code, txn_date, user_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        [sessionId, receiptNo, locCode, macCode, txnDate, userId]
      );
      return {
        id: result.insertId,
        sessionId,
        receiptNo,
        locCode,
        macCode,
        txnDate,
        userId,
        status: 'open'
      };
    });
  }

  /**
   * Get an open draft for a session (returns the latest open draft).
   */
  async function getOpenDraft(sessionId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id, session_id, receipt_no, loc_code, mac_code, txn_date,
                user_id, status, gross_amt, discount_total, net_amt,
                created_at, updated_at
         FROM bill_drafts
         WHERE session_id = ? AND status = 'open'
         ORDER BY id DESC
         LIMIT 1`,
        [sessionId]
      );
      return rows.length > 0 ? rows[0] : null;
    });
  }

  /**
   * Add an item to a draft. seq_no auto-increments.
   */
  async function addItem({ draftId, productId, itemCode, description, qty, unitPrice, discount, total, metadata }) {
    return database.withConnection(async (connection) => {
      // Get the next seq_no for this draft
      const [maxSeq] = await connection.execute(
        'SELECT COALESCE(MAX(seq_no), 0) AS maxSeq FROM bill_draft_items WHERE draft_id = ?',
        [draftId]
      );
      const nextSeq = (maxSeq[0]?.maxSeq || 0) + 1;

      const [result] = await connection.execute(
        `INSERT INTO bill_draft_items
           (draft_id, seq_no, product_id, item_code, description, qty, unit_price, discount, total, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
        [draftId, nextSeq, productId || null, itemCode, description, qty, unitPrice, discount, total, JSON.stringify(metadata || {})]
      );

      // Update draft totals
      await recalcDraftTotals(connection, draftId);

      return {
        id: result.insertId,
        draftId,
        seqNo: nextSeq,
        productId,
        itemCode,
        description,
        qty,
        unitPrice,
        discount,
        total
      };
    });
  }

  /**
   * Update an existing draft item (e.g., change qty, which recalculates total).
   */
  async function updateItem({ itemId, qty, unitPrice, discount, total }) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        'SELECT draft_id FROM bill_draft_items WHERE id = ?',
        [itemId]
      );
      if (rows.length === 0) throw new Error(`Draft item ${itemId} not found.`);
      const draftId = rows[0].draft_id;

      await connection.execute(
        `UPDATE bill_draft_items
         SET qty = ?, unit_price = ?, discount = ?, total = ?
         WHERE id = ?`,
        [qty, unitPrice, discount, total, itemId]
      );

      await recalcDraftTotals(connection, draftId);
    });
  }

  /**
   * Remove an item from a draft.
   */
  async function removeItem(itemId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        'SELECT draft_id FROM bill_draft_items WHERE id = ?',
        [itemId]
      );
      if (rows.length === 0) throw new Error(`Draft item ${itemId} not found.`);
      const draftId = rows[0].draft_id;

      await connection.execute('DELETE FROM bill_draft_items WHERE id = ?', [itemId]);
      await recalcDraftTotals(connection, draftId);
    });
  }

  /**
   * Get all items for a draft, ordered by seq_no.
   */
  async function getItems(draftId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id, draft_id, seq_no, product_id, item_code, description,
                qty, unit_price, discount, total, metadata, created_at
         FROM bill_draft_items
         WHERE draft_id = ?
         ORDER BY seq_no ASC`,
        [draftId]
      );
      return rows;
    });
  }

  /**
   * Mark a draft as finalized (after invoice is created).
   */
  async function finalizeDraft(draftId) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        "UPDATE bill_drafts SET status = 'finalized' WHERE id = ?",
        [draftId]
      );
    });
  }

  /**
   * Mark a draft as cancelled.
   */
  async function cancelDraft(draftId) {
    return database.withConnection(async (connection) => {
      await connection.execute(
        "UPDATE bill_drafts SET status = 'cancelled' WHERE id = ?",
        [draftId]
      );
    });
  }

  /**
   * Delete all draft items and cancel the draft (for clear bill).
   */
  async function clearDraft(draftId) {
    return database.withConnection(async (connection) => {
      await connection.execute('DELETE FROM bill_draft_items WHERE draft_id = ?', [draftId]);
      await connection.execute(
        "UPDATE bill_drafts SET status = 'cancelled', gross_amt = 0, discount_total = 0, net_amt = 0 WHERE id = ?",
        [draftId]
      );
    });
  }

  /**
   * Get a draft record by its ID.
   */
  async function getDraftById(draftId) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT id, session_id, receipt_no, loc_code, mac_code, txn_date,
                user_id, status, gross_amt, discount_total, net_amt,
                created_at, updated_at
         FROM bill_drafts
         WHERE id = ?`,
        [draftId]
      );
      return rows.length > 0 ? rows[0] : null;
    });
  }

  /**
   * List open drafts for recall bill functionality.
   * Groups by receipt_no, returns summary with item count.
   */
  async function listOpenDrafts({ locCode, macCode, txnDate }) {
    return database.withConnection(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT bd.id, bd.receipt_no, bd.loc_code, bd.mac_code, bd.txn_date,
                bd.user_id, bd.gross_amt, bd.net_amt, bd.created_at,
                COUNT(bdi.id) AS item_count
         FROM bill_drafts bd
         LEFT JOIN bill_draft_items bdi ON bdi.draft_id = bd.id
         WHERE bd.status = 'open'
           AND bd.loc_code = ?
           AND bd.mac_code = ?
           AND bd.txn_date = ?
         GROUP BY bd.id
         ORDER BY bd.created_at DESC`,
        [locCode, macCode, txnDate]
      );
      return rows;
    });
  }

  // ── Internal helpers ──────────────────────────────────────

  async function recalcDraftTotals(connection, draftId) {
    const [agg] = await connection.execute(
      `SELECT
         COALESCE(SUM(unit_price * qty), 0) AS gross,
         COALESCE(SUM(discount), 0)        AS disc,
         COALESCE(SUM(total), 0)           AS net
       FROM bill_draft_items
       WHERE draft_id = ?`,
      [draftId]
    );
    await connection.execute(
      `UPDATE bill_drafts
       SET gross_amt = ?, discount_total = ?, net_amt = ?
       WHERE id = ?`,
      [agg[0].gross, agg[0].disc, agg[0].net, draftId]
    );
  }

  return {
    openDraft,
    getOpenDraft,
    getDraftById,
    addItem,
    updateItem,
    removeItem,
    getItems,
    finalizeDraft,
    cancelDraft,
    clearDraft,
    listOpenDrafts
  };
}

module.exports = {
  createBillDraftRepository
};
