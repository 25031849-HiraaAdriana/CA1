const session = require('express-session');
const connection = require('../config/db');

class MySQLSessionStore extends session.Store {
  get(sessionId, callback) {
    connection.query(
      'SELECT data FROM pomi_sessions WHERE session_id = ? AND expires > ? LIMIT 1',
      [sessionId, Math.floor(Date.now() / 1000)],
      (error, rows) => {
        if (error) return callback(error);
        if (!rows.length) return callback(null, null);
        try {
          return callback(null, JSON.parse(rows[0].data));
        } catch (parseError) {
          return callback(parseError);
        }
      }
    );
  }

  set(sessionId, sessionData, callback = () => {}) {
    const expires = this.expirySeconds(sessionData);
    if (!expires) return callback(new Error('Session expiry is invalid.'));
    const serialized = JSON.stringify(sessionData);
    return connection.query(
      `INSERT INTO pomi_sessions (session_id, expires, data)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
      [sessionId, expires, serialized],
      callback
    );
  }

  touch(sessionId, sessionData, callback = () => {}) {
    const expires = this.expirySeconds(sessionData);
    if (!expires) return callback(new Error('Session expiry is invalid.'));
    return connection.query(
      'UPDATE pomi_sessions SET expires = ? WHERE session_id = ?',
      [expires, sessionId],
      callback
    );
  }

  destroy(sessionId, callback = () => {}) {
    return connection.query(
      'DELETE FROM pomi_sessions WHERE session_id = ?',
      [sessionId],
      callback
    );
  }

  pruneExpired(callback = () => {}) {
    return connection.query(
      'DELETE FROM pomi_sessions WHERE expires <= ?',
      [Math.floor(Date.now() / 1000)],
      callback
    );
  }

  expirySeconds(sessionData) {
    const expiry = sessionData.cookie && sessionData.cookie.expires
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now();
    return Number.isFinite(expiry) && expiry > Date.now()
      ? Math.floor(expiry / 1000)
      : null;
  }
}

module.exports = MySQLSessionStore;
