function createDocumentSequenceRepository({ database }) {
  if (!database) throw new Error('Document sequence repository requires a database instance.');

  function normalizeContext({ documentType, locCode, macCode, txnDate }) {
    const normalizedDate = txnDate instanceof Date
      ? `${txnDate.getFullYear()}-${String(txnDate.getMonth() + 1).padStart(2, '0')}-${String(txnDate.getDate()).padStart(2, '0')}`
      : String(txnDate || '').slice(0, 10);
    const context = {
      documentType: String(documentType || '').trim().toLowerCase(),
      locCode: String(locCode || '').trim(),
      macCode: String(macCode || '').trim(),
      txnDate: normalizedDate
    };
    if (!context.documentType || !context.locCode || !context.macCode || !/^\d{4}-\d{2}-\d{2}$/.test(context.txnDate)) {
      throw new Error('A document number requires a document type, location, machine, and transaction date.');
    }
    return context;
  }

  async function allocateWithConnection(connection, input) {
    const context = normalizeContext(input);
    await connection.execute(
      `INSERT INTO document_sequences (document_type, loc_code, mac_code, txn_date, next_number)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE next_number = next_number`,
      [context.documentType, context.locCode, context.macCode, context.txnDate]
    );
    const [rows] = await connection.execute(
      `SELECT next_number FROM document_sequences
       WHERE document_type = ? AND loc_code = ? AND mac_code = ? AND txn_date = ? FOR UPDATE`,
      [context.documentType, context.locCode, context.macCode, context.txnDate]
    );
    const number = Number(rows[0]?.next_number);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid ${context.documentType} document sequence state.`);
    await connection.execute(
      `UPDATE document_sequences SET next_number = next_number + 1
       WHERE document_type = ? AND loc_code = ? AND mac_code = ? AND txn_date = ?`,
      [context.documentType, context.locCode, context.macCode, context.txnDate]
    );
    return number;
  }

  async function allocate(input) {
    return database.withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const number = await allocateWithConnection(connection, input);
        await connection.commit();
        return number;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  return { allocate, allocateWithConnection };
}

module.exports = { createDocumentSequenceRepository };
