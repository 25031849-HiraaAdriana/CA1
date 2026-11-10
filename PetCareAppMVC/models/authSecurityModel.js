const connection = require('../config/db');
const database = connection.promise();

const accountColumns = `id, username, password, name, role,
  totp_enabled, totp_secret_encrypted, totp_pending_secret_encrypted,
  totp_pending_expires_at, totp_last_used_step, totp_failed_attempts,
  totp_locked_until, (totp_locked_until > UTC_TIMESTAMP()) AS totp_is_locked`;

async function findAccountByUsername(username) {
  const [accounts] = await database.execute(
    `SELECT ${accountColumns} FROM users WHERE username = ? LIMIT 1`,
    [username]
  );
  return accounts[0] || null;
}

async function findAccountById(id) {
  const [accounts] = await database.execute(
    `SELECT ${accountColumns} FROM users WHERE id = ? LIMIT 1`,
    [id]
  );
  return accounts[0] || null;
}

async function isInitialAdminSetupComplete() {
  const [rows] = await database.execute(
    'SELECT setup_completed_at FROM pomi_admin_setup_state WHERE id = 1 LIMIT 1'
  );
  if (rows.length !== 1) throw new Error('Admin setup state is not initialized.');
  return rows[0].setup_completed_at !== null;
}

async function beginTotpEnrollment(userId, encryptedSecret) {
  await database.execute(
    `UPDATE users
     SET totp_pending_secret_encrypted = ?,
         totp_pending_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)
     WHERE id = ?`,
    [encryptedSecret, userId]
  );
}

async function getPendingTotpSecret(userId) {
  const [rows] = await database.execute(
    `SELECT totp_pending_secret_encrypted
     FROM users
     WHERE id = ? AND totp_pending_expires_at > UTC_TIMESTAMP()
     LIMIT 1`,
    [userId]
  );
  return rows[0]?.totp_pending_secret_encrypted || null;
}

async function consumeTotpFailure(userId) {
  const [result] = await database.execute(
    `UPDATE users
     SET totp_failed_attempts = CASE
           WHEN totp_locked_until IS NOT NULL AND totp_locked_until <= UTC_TIMESTAMP() THEN 1
           ELSE totp_failed_attempts + 1
         END,
         totp_locked_until = CASE
           WHEN totp_locked_until IS NOT NULL AND totp_locked_until <= UTC_TIMESTAMP() THEN NULL
           WHEN totp_failed_attempts >= 5
           THEN DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)
           ELSE NULL
         END
     WHERE id = ?
       AND (totp_locked_until IS NULL OR totp_locked_until <= UTC_TIMESTAMP())`,
    [userId]
  );
  return result.affectedRows === 1;
}

async function recordValidTotp(userId, timeStep) {
  const [result] = await database.execute(
    `UPDATE users
     SET totp_last_used_step = ?, totp_failed_attempts = 0, totp_locked_until = NULL
     WHERE id = ?
       AND (totp_last_used_step IS NULL OR totp_last_used_step < ?)
       AND (totp_locked_until IS NULL OR totp_locked_until <= UTC_TIMESTAMP())`,
    [timeStep, userId, timeStep]
  );
  return result.affectedRows === 1;
}

async function consumeRecoveryCode(userId, verifier) {
  const dbConnection = await database.getConnection();
  try {
    await dbConnection.beginTransaction();
    const [result] = await dbConnection.execute(
      'DELETE FROM pomi_totp_recovery_codes WHERE user_id = ? AND verifier = ?',
      [userId, verifier]
    );
    if (result.affectedRows !== 1) {
      await dbConnection.rollback();
      return false;
    }
    await dbConnection.execute(
      'UPDATE users SET totp_failed_attempts = 0, totp_locked_until = NULL WHERE id = ?',
      [userId]
    );
    await dbConnection.commit();
    return true;
  } catch (error) {
    await dbConnection.rollback();
    throw error;
  } finally {
    dbConnection.release();
  }
}

async function activateTotp(userId, encryptedSecret, timeStep, recoveryVerifiers) {
  const dbConnection = await database.getConnection();
  try {
    await dbConnection.beginTransaction();
    const [result] = await dbConnection.execute(
      `UPDATE users
       SET totp_secret_encrypted = ?,
           totp_enabled = 1,
           totp_pending_secret_encrypted = NULL,
           totp_pending_expires_at = NULL,
           totp_last_used_step = ?,
           totp_failed_attempts = 0,
           totp_locked_until = NULL
       WHERE id = ?
         AND totp_pending_secret_encrypted = ?
         AND totp_pending_expires_at > UTC_TIMESTAMP()`,
      [encryptedSecret, timeStep, userId, encryptedSecret]
    );
    if (result.affectedRows !== 1) throw new Error('Authenticator setup expired. Start setup again.');

    await dbConnection.execute(
      'DELETE FROM pomi_totp_recovery_codes WHERE user_id = ?',
      [userId]
    );
    for (const verifier of recoveryVerifiers) {
      await dbConnection.execute(
        'INSERT INTO pomi_totp_recovery_codes (user_id, verifier) VALUES (?, ?)',
        [userId, verifier]
      );
    }
    await dbConnection.commit();
  } catch (error) {
    await dbConnection.rollback();
    throw error;
  } finally {
    dbConnection.release();
  }
}

async function disableTotp(userId) {
  const dbConnection = await database.getConnection();
  try {
    await dbConnection.beginTransaction();
    const [result] = await dbConnection.execute(
      `UPDATE users SET totp_enabled = 0, totp_secret_encrypted = NULL,
       totp_pending_secret_encrypted = NULL, totp_pending_expires_at = NULL,
       totp_last_used_step = NULL, totp_failed_attempts = 0, totp_locked_until = NULL
       WHERE id = ? AND role = 'user'`,
      [userId]
    );
    if (result.affectedRows !== 1) throw new Error('Only User accounts can disable TOTP.');
    await dbConnection.execute('DELETE FROM pomi_totp_recovery_codes WHERE user_id = ?', [userId]);
    await dbConnection.commit();
  } catch (error) {
    await dbConnection.rollback();
    throw error;
  } finally {
    dbConnection.release();
  }
}

async function createAdditionalAdmin(username, hashedPassword, name) {
  const [result] = await database.execute(
    `INSERT INTO users (username, password, name, role)
     VALUES (?, ?, ?, 'admin')`,
    [username, hashedPassword, name]
  );
  return result.insertId;
}

async function createInitialAdmin(username, hashedPassword, name, pendingSecret) {
  const dbConnection = await database.getConnection();
  try {
    await dbConnection.beginTransaction();
    const [states] = await dbConnection.execute(
      'SELECT setup_completed_at FROM pomi_admin_setup_state WHERE id = 1 FOR UPDATE'
    );
    if (states.length !== 1 || states[0].setup_completed_at !== null) {
      throw new Error('Initial Admin setup is already complete.');
    }
    const [admins] = await dbConnection.execute(
      `SELECT id FROM users WHERE role = 'admin' LIMIT 1 FOR UPDATE`
    );
    if (admins.length) throw new Error('An Admin account already exists.');

    const [result] = await dbConnection.execute(
      `INSERT INTO users
       (username, password, name, role, totp_pending_secret_encrypted, totp_pending_expires_at)
       VALUES (?, ?, ?, 'admin', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))`,
      [username, hashedPassword, name, pendingSecret]
    );
    await dbConnection.execute(
      'UPDATE pomi_admin_setup_state SET setup_completed_at = UTC_TIMESTAMP() WHERE id = 1'
    );
    await dbConnection.commit();
    return result.insertId;
  } catch (error) {
    await dbConnection.rollback();
    throw error;
  } finally {
    dbConnection.release();
  }
}

module.exports = {
  activateTotp,
  beginTotpEnrollment,
  consumeRecoveryCode,
  consumeTotpFailure,
  createAdditionalAdmin,
  createInitialAdmin,
  disableTotp,
  findAccountById,
  findAccountByUsername,
  getPendingTotpSecret,
  isInitialAdminSetupComplete,
  recordValidTotp
};
