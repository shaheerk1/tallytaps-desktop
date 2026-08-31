const mysql = require('mysql2/promise');

function createDatabase() {
  const config = {
    host: process.env.POS_DB_HOST || 'localhost',
    port: Number(process.env.POS_DB_PORT || 3306),
    user: process.env.POS_DB_USER || 'root',
    password: process.env.POS_DB_PASSWORD || 'root',
    database: process.env.POS_DB_NAME || 'pos_platform',
    multipleStatements: true
  };

  let pool = null;
  let initialized = false;

  async function ensureDatabase() {
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password
    });

    try {
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\``);
    } finally {
      await connection.end();
    }
  }

  async function getPool() {
    if (!pool) {
      pool = mysql.createPool({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        multipleStatements: true,
        connectionLimit: 10,
        waitForConnections: true,
        queueLimit: 0
      });
    }

    if (!initialized) {
      await ensureDatabase();
      initialized = true;
    }

    return pool;
  }

  async function withConnection(callback) {
    const p = await getPool();
    const connection = await p.getConnection();

    try {
      return await callback(connection);
    } finally {
      connection.release();
    }
  }

  async function close() {
    if (pool) {
      await pool.end();
      pool = null;
      initialized = false;
    }
  }

  return {
    config: {
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database
    },
    ensureDatabase,
    withConnection,
    close
  };
}

module.exports = {
  createDatabase
};
