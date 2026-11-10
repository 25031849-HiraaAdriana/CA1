-- HISTORICAL PROPOSAL ONLY: do not apply. Authenticator functionality was removed.
-- Retained solely to identify possible previously-created schema objects for review.
-- Whether this SQL was ever applied is unknown until a read-only schema inspection.
-- Do not remove any existing columns or tables without separate review and approval.

ALTER TABLE users
  ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN totp_secret_encrypted VARCHAR(512) NULL,
  ADD COLUMN totp_pending_secret_encrypted VARCHAR(512) NULL,
  ADD COLUMN totp_pending_expires_at DATETIME NULL,
  ADD COLUMN totp_last_used_step BIGINT UNSIGNED NULL,
  ADD COLUMN totp_failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN totp_locked_until DATETIME NULL;

CREATE TABLE pomi_totp_recovery_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  verifier CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pomi_totp_recovery_user_verifier (user_id, verifier),
  CONSTRAINT fk_pomi_totp_recovery_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE pomi_admin_setup_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  setup_completed_at DATETIME NULL
) ENGINE=InnoDB;

INSERT INTO pomi_admin_setup_state (id, setup_completed_at)
SELECT 1,
  CASE WHEN EXISTS (SELECT 1 FROM users WHERE role = 'admin')
    THEN UTC_TIMESTAMP()
    ELSE NULL
  END;

CREATE TABLE pomi_sessions (
  session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT COLLATE utf8mb4_bin,
  KEY idx_pomi_sessions_expires (expires)
) ENGINE=InnoDB;
