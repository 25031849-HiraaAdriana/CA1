USE petcare;

CREATE TABLE IF NOT EXISTS admin_activity_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_id INT UNSIGNED NOT NULL,
  admin_username VARCHAR(50) NOT NULL,
  admin_name VARCHAR(100) NOT NULL,
  action_type VARCHAR(80) NOT NULL,
  target_entity_type VARCHAR(80) NOT NULL DEFAULT 'system',
  target_entity_id BIGINT UNSIGNED NULL,
  pet_id INT UNSIGNED NULL,
  pet_name VARCHAR(80) NULL,
  medical_record_id BIGINT UNSIGNED NULL,
  medical_record_title VARCHAR(200) NULL,
  action_result ENUM('success','failure','denied') NOT NULL DEFAULT 'success',
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_admin_activity_logs_admin_time (admin_id, created_at),
  KEY idx_admin_activity_logs_action_time (action_type, created_at),
  KEY idx_admin_activity_logs_pet_time (pet_id, created_at),
  KEY idx_admin_activity_logs_medical_record_time (medical_record_id, created_at),
  KEY idx_admin_activity_logs_result_time (action_result, created_at),

  CONSTRAINT fk_admin_activity_logs_admin
    FOREIGN KEY (admin_id) REFERENCES users(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_admin_activity_logs_pet
    FOREIGN KEY (pet_id) REFERENCES pets(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_admin_activity_logs_medical_record
    FOREIGN KEY (medical_record_id) REFERENCES medical_records(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS medical_record_signatures (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  medical_record_id BIGINT UNSIGNED NOT NULL,
  admin_id INT UNSIGNED NOT NULL,
  signature_storage_key VARCHAR(255) NOT NULL,
  signature_mime_type VARCHAR(50) NOT NULL,
  signature_size_bytes BIGINT UNSIGNED NOT NULL,
  review_version_hash CHAR(64) NOT NULL,
  original_document_fingerprint CHAR(64) NOT NULL,
  approval_status ENUM('approved','rejected','revoked') NOT NULL DEFAULT 'approved',
  signed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  related_audit_activity_id BIGINT UNSIGNED NOT NULL,

  UNIQUE KEY uq_medical_record_signature_version
    (medical_record_id, review_version_hash),
  KEY idx_medical_record_signatures_record (medical_record_id, signed_at),
  KEY idx_medical_record_signatures_admin (admin_id, signed_at),
  KEY idx_medical_record_signatures_audit (related_audit_activity_id),

  CONSTRAINT fk_medical_record_signatures_medical_record
    FOREIGN KEY (medical_record_id) REFERENCES medical_records(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_medical_record_signatures_admin
    FOREIGN KEY (admin_id) REFERENCES users(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_medical_record_signatures_audit
    FOREIGN KEY (related_audit_activity_id) REFERENCES admin_activity_logs(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,

  CONSTRAINT chk_medical_record_signatures_signature_size
    CHECK (signature_size_bytes > 0),
  CONSTRAINT chk_medical_record_signatures_mime_type
    CHECK (signature_mime_type IN ('image/png', 'image/jpeg')),
  CONSTRAINT chk_medical_record_signatures_hash_length
    CHECK (CHAR_LENGTH(review_version_hash) = 64),
  CONSTRAINT chk_medical_record_signatures_original_hash_length
    CHECK (CHAR_LENGTH(original_document_fingerprint) = 64)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
