const fs = require('fs/promises');
const path = require('path');

const CORE_MIGRATION_DIR = path.join(__dirname, 'migrations/core');

async function createMigrationRunner({ database, migrationDir = CORE_MIGRATION_DIR } = {}) {
  if (!database) {
    throw new Error('Migration runner requires a database instance.');
  }

  async function getMigrationFiles() {
    const files = await fs.readdir(migrationDir);

    return files
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => ({
        name: file,
        path: path.join(migrationDir, file)
      }));
  }

  async function ensureMigrationTable(connection) {
    const migrationSql = await fs.readFile(
      path.join(migrationDir, '001_create_core_migrations.sql'),
      'utf8'
    );

    await connection.query(migrationSql);
  }

  async function getExecutedMigrations(connection) {
    const [rows] = await connection.query('SELECT migration_name FROM core_migrations');
    return new Set(rows.map((row) => row.migration_name));
  }

  async function getNextBatch(connection) {
    const [rows] = await connection.query('SELECT COALESCE(MAX(batch), 0) + 1 AS nextBatch FROM core_migrations');
    return rows[0].nextBatch;
  }

  async function status() {
    return database.withConnection(async (connection) => {
      await ensureMigrationTable(connection);

      const files = await getMigrationFiles();
      const executed = await getExecutedMigrations(connection);

      return {
        database: database.config.database,
        total: files.length,
        executed: files.filter((file) => executed.has(file.name)).length,
        pending: files.filter((file) => !executed.has(file.name)).map((file) => file.name)
      };
    });
  }

  async function runPending() {
    return database.withConnection(async (connection) => {
      await ensureMigrationTable(connection);

      const files = await getMigrationFiles();
      const executed = await getExecutedMigrations(connection);
      const pending = files.filter((file) => !executed.has(file.name));

      if (pending.length === 0) {
        return {
          database: database.config.database,
          batch: null,
          executed: []
        };
      }

      const batch = await getNextBatch(connection);
      const applied = [];

      for (const migration of pending) {
        const sql = await fs.readFile(migration.path, 'utf8');

        await connection.beginTransaction();

        try {
          await connection.query(sql);
          await connection.execute(
            'INSERT INTO core_migrations (migration_name, batch) VALUES (?, ?)',
            [migration.name, batch]
          );
          await connection.commit();
          applied.push(migration.name);
        } catch (error) {
          await connection.rollback();
          throw new Error(`Failed migration ${migration.name}: ${error.message}`);
        }
      }

      return {
        database: database.config.database,
        batch,
        executed: applied
      };
    });
  }

  return {
    status,
    runPending
  };
}

module.exports = {
  createMigrationRunner
};
