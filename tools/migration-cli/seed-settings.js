const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createMigrationRunner } = require('../../packages/database/migration-runner');
const { seedDefaultSettings } = require('../../packages/database/seeders/seed-default-settings');

async function run() {
  const database = createDatabase();

  console.log('Running pending core migrations...');
  const migrationRunner = await createMigrationRunner({ database });
  const migrationResult = await migrationRunner.runPending();
  console.log(JSON.stringify(migrationResult, null, 2));

  console.log('Seeding default system settings...');
  const seedResult = await seedDefaultSettings(database);
  console.log(JSON.stringify(seedResult, null, 2));

  await database.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
