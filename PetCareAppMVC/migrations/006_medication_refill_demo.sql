USE petcare;

CREATE TABLE IF NOT EXISTS medication_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  medical_record_id BIGINT UNSIGNED NOT NULL,
  pet_id INT UNSIGNED NOT NULL,
  medication_name VARCHAR(200) NOT NULL,
  dosage VARCHAR(120) NULL,
  frequency VARCHAR(120) NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  recorded_by_admin_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_medication_entries_id_record_pet
    (id, medical_record_id, pet_id),
  KEY idx_medication_entries_record (medical_record_id),
  KEY idx_medication_entries_pet (pet_id),

  CONSTRAINT fk_medication_entries_record
    FOREIGN KEY (medical_record_id) REFERENCES medical_records(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_medication_entries_pet
    FOREIGN KEY (pet_id) REFERENCES pets(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_medication_entries_admin
    FOREIGN KEY (recorded_by_admin_id) REFERENCES users(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT chk_medication_entries_dates
    CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS medication_refill_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  medication_entry_id BIGINT UNSIGNED NOT NULL,
  medical_record_id BIGINT UNSIGNED NOT NULL,
  pet_id INT UNSIGNED NOT NULL,
  owner_id INT UNSIGNED NOT NULL,
  request_key CHAR(36) NOT NULL,
  message VARCHAR(500) NULL,
  status ENUM(
    'Pending',
    'More Information Required',
    'Rejected',
    'Ready for Test Payment',
    'Paid'
  ) NOT NULL DEFAULT 'Pending',
  demo_price_cents INT UNSIGNED NULL,
  admin_review_note VARCHAR(500) NULL,
  reviewed_by_admin_id INT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  active_request TINYINT GENERATED ALWAYS AS (
    CASE WHEN status = 'Rejected' THEN NULL ELSE 1 END
  ) STORED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_medication_refill_request_key (request_key),
  UNIQUE KEY uq_medication_refill_active_request
    (owner_id, medication_entry_id, active_request),
  KEY idx_medication_refill_owner_status (owner_id, status, created_at),
  KEY idx_medication_refill_status_created (status, created_at),
  KEY idx_medication_refill_record (medical_record_id),

  CONSTRAINT fk_medication_refill_medication_record_pet
    FOREIGN KEY (medication_entry_id, medical_record_id, pet_id)
    REFERENCES medication_entries(id, medical_record_id, pet_id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_medication_refill_record
    FOREIGN KEY (medical_record_id) REFERENCES medical_records(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_medication_refill_pet
    FOREIGN KEY (pet_id) REFERENCES pets(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_medication_refill_owner
    FOREIGN KEY (owner_id) REFERENCES users(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_medication_refill_admin
    FOREIGN KEY (reviewed_by_admin_id) REFERENCES users(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT chk_medication_refill_review_fields
    CHECK (
      (reviewed_by_admin_id IS NULL AND reviewed_at IS NULL)
      OR
      (reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
  CONSTRAINT chk_medication_refill_demo_price
    CHECK (
      (status IN ('Ready for Test Payment', 'Paid')
        AND demo_price_cents IS NOT NULL AND demo_price_cents > 0)
      OR
      (status NOT IN ('Ready for Test Payment', 'Paid') AND demo_price_cents IS NULL)
    ),
  CONSTRAINT chk_medication_refill_reviewed_status
    CHECK (
      status = 'Pending'
      OR (reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL)
    )
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
