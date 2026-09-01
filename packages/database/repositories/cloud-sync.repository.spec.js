const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloudSyncRepository } = require('./cloud-sync.repository');

test('cloud archive queries use safe literal limits for MySQL prepared statements', async () => {
  const statements = [];
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    execute: async (sql) => {
      statements.push(sql);
      return [[]];
    }
  };
  const repository = createCloudSyncRepository({
    database: { withConnection: async (callback) => callback(connection) }
  });

  await repository.collectChanges(1);
  await repository.pendingBatch(999999);

  const selectStatements = statements.filter((sql) => /\bLIMIT\b/.test(sql));
  assert.ok(selectStatements.length > 1);
  assert.equal(selectStatements.some((sql) => /LIMIT\s+\?/i.test(sql)), false);
  assert.ok(selectStatements.some((sql) => /LIMIT 1\b/.test(sql)));
  assert.ok(selectStatements.some((sql) => /LIMIT 500\b/.test(sql)));
});
