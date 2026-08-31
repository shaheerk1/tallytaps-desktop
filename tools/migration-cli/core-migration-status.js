const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createMigrationRunner } = require('../../packages/database/migration-runner');

async function main() {
  const database = createDatabase();
  const runner = await createMigrationRunner({ database });
  const result = await runner.status();

  console.log(JSON.stringify(result, null, 2));
  await database.close();
  process.exit(0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
