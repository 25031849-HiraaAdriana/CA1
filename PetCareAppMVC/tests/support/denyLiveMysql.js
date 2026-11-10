// Preload during offline tests so an unmocked model cannot contact MySQL.
const mysql = require('mysql2');
mysql.createConnection = () => ({
  query() { throw new Error('Unmocked MySQL access is forbidden in offline tests.'); },
  promise() {
    return {
      query: async () => { throw new Error('Unmocked MySQL access is forbidden in offline tests.'); }
    };
  }
});
