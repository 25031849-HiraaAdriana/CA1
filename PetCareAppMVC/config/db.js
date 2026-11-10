const mysql = require('mysql2');
require('./environment').loadEnvironment();

if (!process.env.DB_USER || !process.env.DB_USER.trim()) {
  throw new Error('Set DB_USER to your existing MySQL username in the project .env file.');
}
if (process.env.DB_PASSWORD === undefined) {
  throw new Error('Set DB_PASSWORD in the project .env file (leave it empty only if your MySQL account has no password).');
}

const databaseConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'petcare'
};
const connection = mysql.createPool({
  ...databaseConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

connection.createPetShopTransactionConnection = () => mysql.createConnection(databaseConfig);

module.exports = connection;
