function createDatabaseHealthService({ database }) {
  return {
    async check() {
      const rows = await database.withConnection(async (connection) => {
        const [result] = await connection.execute('SELECT NOW() AS databaseTime');
        return result;
      });

      return {
        status: 'ok',
        databaseTime: rows[0].databaseTime
      };
    }
  };
}

module.exports = {
  createDatabaseHealthService
};
