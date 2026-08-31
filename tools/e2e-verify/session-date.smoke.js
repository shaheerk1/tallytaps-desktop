const { createDatabase } = require('../../packages/database/connection/mysql-connection');
const { createWorkstationRepository } = require('../../packages/database/repositories/workstation.repository');
const { createAuthRepository } = require('../../packages/database/repositories/auth.repository');

async function main() {
  const database = createDatabase();
  const wsRepo = createWorkstationRepository({ database });
  const authRepo = createAuthRepository({ database });
  const results = [];
  const log = (label, ok, detail) => {
    results.push({ label, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  };

  try {
    let userId = null;
    if (authRepo && typeof authRepo.findByUsername === 'function') {
      const admin = await authRepo.findByUsername('admin');
      userId = admin ? admin.id : null;
    }
    if (!userId) {
      const [rows] = await database.withConnection((c) =>
        c.execute('SELECT id FROM users ORDER BY id LIMIT 1')
      );
      userId = rows[0] ? rows[0].id : null;
    }

    let workstationId = null;
    const [wsRows] = await database.withConnection((c) =>
      c.execute('SELECT id FROM pos_workstations ORDER BY id LIMIT 1')
    );
    if (wsRows.length > 0) {
      workstationId = wsRows[0].id;
    } else {
      const [ins] = await database.withConnection((c) =>
        c.execute(
          "INSERT INTO pos_workstations (location_code, machine_code, name, status) VALUES ('E2E', 'DATE', 'E2E Date Smoke', 'inactive')"
        )
      );
      workstationId = ins.insertId;
    }
    if (!userId) {
      console.log('SKIP  no user row available to run updateSessionDate check');
      return;
    }

    const dateA = '2026-08-01';
    const dateB = '2026-08-02';
    const session = await wsRepo.openSession({ workstationId, userId, billingDate: dateA, openingBalance: 0 });
    log('openSession created', !!session, `session=${session.id} date=${session.billingDate}`);

    // Simulate a prior day's session already existing on the target date.
    const prior = await wsRepo.openSession({ workstationId, userId, billingDate: dateB, openingBalance: 0 });
    await wsRepo.closeSession(userId);
    await database.withConnection((c) =>
      c.execute('UPDATE workstation_sessions SET current_receipt_no = 5 WHERE id = ?', [prior.id])
    );

    // Re-open the working session on dateA (updateSessionDate needs an open one).
    const working = await wsRepo.openSession({ workstationId, userId, billingDate: dateA, openingBalance: 0 });

    // Carry-forward = MAX(current counter, highest counter already used on the target date).
    const [maxRows] = await database.withConnection((c) =>
      c.execute(
        `SELECT COALESCE(MAX(current_receipt_no), 1) AS maxNo
         FROM workstation_sessions
         WHERE workstation_id = ? AND billing_date = ?`,
        [workstationId, dateB]
      )
    );
    const expectedNo = Math.max(working.currentReceiptNo, maxRows[0].maxNo);

    const updated = await wsRepo.updateSessionDate(userId, dateB);
    log(
      'updateSessionDate supersedes prior session + carries counter',
      !!updated && updated.billingDate === dateB && updated.currentReceiptNo === expectedNo,
      JSON.stringify(updated)
    );

    const active = await wsRepo.getActiveSession(userId);
    const d = new Date(active.billing_date);
    const activeDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    log('getActiveSession reflects new date', !!active && activeDateStr === dateB, `date=${activeDateStr}`);

    const priorGone = await database.withConnection((c) =>
      c.execute('SELECT id FROM workstation_sessions WHERE id = ?', [prior.id])
    );
    log('superseded prior session removed', priorGone[0].length === 0);

    await wsRepo.closeSession(userId);
    const afterClose = await wsRepo.updateSessionDate(userId, dateA);
    log('updateSessionDate with no open session returns null', afterClose === null, JSON.stringify(afterClose));
  } catch (err) {
    console.error('ERROR', err);
    results.push({ label: 'runtime', ok: false, detail: err.message });
  } finally {
    try {
      await database.dispose();
    } catch {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
