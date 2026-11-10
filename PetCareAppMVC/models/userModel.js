const connection = require('../config/db');
const database = connection.promise();

function createUser(username, hashedPassword, name, role, callback) {
  const sql = 'INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)';
  connection.query(sql, [username, hashedPassword, name, role], callback);
}

function findByCredentials(username, hashedPassword, callback) {
  const sql = `SELECT id, username, name, role FROM users
    WHERE username = ? AND password = ?`;
  connection.query(sql, [username, hashedPassword], callback);
}

function getAllUsers(callback) {
  const sql = 'SELECT id, name, username, role FROM users';
  connection.query(sql, callback);
}

function getUserById(userId, callback) {
  const sql = 'SELECT id, name, username, role FROM users WHERE id = ?';
  connection.query(sql, [userId], callback);
}

function deleteUser(userId, callback) {
  const sql = `DELETE FROM users
    WHERE id = ? AND role = 'user'
      AND NOT EXISTS (SELECT 1 FROM pets p WHERE p.owner_id = users.id)`;
  connection.query(sql, [userId], callback);
}

async function findUser(userId) {
  const [users] = await database.query(
    'SELECT id, name, username, role FROM users WHERE id = ? LIMIT 1',
    [userId]
  );
  return users[0] || null;
}

async function updateUserProfile(userId, profile) {
  const [result] = await database.query(
    'UPDATE users SET name = ?, username = ? WHERE id = ?',
    [profile.name, profile.username, userId]
  );
  if (result.affectedRows > 0) return true;
  const [users] = await database.query('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
  return users.length === 1;
}

async function getUserDeletionTarget(userId) {
  const [users] = await database.query(
    `SELECT u.id, u.name, u.username, u.role,
       EXISTS(SELECT 1 FROM pets p WHERE p.owner_id = u.id) AS has_pets
     FROM users u WHERE u.id = ? LIMIT 1`,
    [userId]
  );
  return users[0] || null;
}

async function deleteUserIfNoPets(userId, username) {
  const [result] = await database.query(
    `DELETE FROM users
     WHERE id = ? AND role = 'user' AND username = ?
       AND NOT EXISTS (SELECT 1 FROM pets p WHERE p.owner_id = users.id)`,
    [userId, username]
  );
  return result.affectedRows === 1;
}

module.exports = {
  createUser,
  findByCredentials,
  getAllUsers,
  getUserById,
  deleteUser,
  findUser,
  updateUserProfile,
  getUserDeletionTarget,
  deleteUserIfNoPets
};
