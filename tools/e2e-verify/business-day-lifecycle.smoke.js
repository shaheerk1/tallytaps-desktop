const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createBusinessDayRepository } = require('../../packages/database/repositories/business-day.repository');

async function main() {
  const realDatabase = createDatabase();
  try {
    await realDatabase.withConnection(async (connection) => {
      await connection.beginTransaction();
      const txConnection = {
        execute: (...args) => connection.execute(...args),
        query: (...args) => connection.query(...args),
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {}
      };
      const database = { withConnection: async (work) => work(txConnection) };
      const repository = createBusinessDayRepository({ database });
      try {
        const [[user]] = await connection.execute('SELECT id FROM users WHERE status = ? ORDER BY id LIMIT 1', ['active']);
        if (!user) throw new Error('Business-day smoke test requires an active user.');
        const locationCode = `BD-SMOKE-${Date.now()}`;
        const [created] = await connection.execute(
          `INSERT INTO business_days (loc_code, business_date, status, opened_by)
           VALUES (?, '2099-01-01', 'open', ?)`,
          [locationCode, user.id]
        );
        const dayId = created.insertId;

        let state = await repository.startClosing({ dayId, userId: user.id });
        if (state.day?.status !== 'closing') throw new Error('Open to closing transition failed.');
        state = await repository.resumeTrading({ dayId, userId: user.id, reason: 'Lifecycle smoke resume' });
        if (state.day?.status !== 'open') throw new Error('Closing cancellation failed.');
        await repository.startClosing({ dayId, userId: user.id });
        let closed = await repository.closeDay({ dayId, userId: user.id, reason: 'Lifecycle smoke close' });
        if (closed.day?.status !== 'closed' || !closed.summary) throw new Error('Business-day close failed.');

        state = await repository.reopenDay({ dayId, userId: user.id, reason: 'Lifecycle smoke reopen' });
        if (state.day?.status !== 'open' || state.day?.reopenCount !== 1) throw new Error('Audited reopen failed.');
        await repository.startClosing({ dayId, userId: user.id });
        closed = await repository.closeDay({ dayId, userId: user.id, reason: 'Lifecycle smoke reclose' });
        if (closed.day?.status !== 'closed') throw new Error('Reopened day could not be closed again.');

        state = await repository.openDay({ locationCode, businessDate: '2099-01-02', userId: user.id });
        if (state.day?.businessDate !== '2099-01-02' || state.day?.status !== 'open') {
          throw new Error('Next business day did not open correctly.');
        }
        console.log('Business-day lifecycle smoke test passed; all writes will be rolled back.');
      } finally {
        await connection.rollback();
      }
    });
  } finally {
    await realDatabase.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
