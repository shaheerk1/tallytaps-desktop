/** Read-only schema check for every desktop-to-cloud archive stream. */
const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { STREAMS } = require('../../packages/database/repositories/cloud-sync.repository');

async function main() {
  const database = createDatabase();
  try {
    await database.withConnection(async (connection) => {
      for (const stream of STREAMS) {
        const filters = [stream.where, '1 = 0'].filter(Boolean).join(' AND ');
        await connection.query(
          `SELECT t.id, t.cloud_sync_updated_at FROM ${stream.table} t ${stream.join || ''} WHERE ${filters}`
        );
      }
    });
    console.log(`Cloud archive stream schema passed for ${STREAMS.length} entity types.`);
  } finally {
    await database.close();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
