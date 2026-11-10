USE petcare;

CREATE TABLE medical_record_categories (
  category_code VARCHAR(50) NOT NULL PRIMARY KEY,
  category_name VARCHAR(100) NOT NULL UNIQUE
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

INSERT INTO medical_record_categories (category_code, category_name) VALUES
  ('x_rays_imaging', 'X-rays & Imaging'),
  ('test_results', 'Test Results'),
  ('medical_history', 'Medical History'),
  ('lab_reports', 'Lab Reports'),
  ('immunisation_records', 'Immunisation Records'),
  ('medication_history', 'Medication History');

CREATE TABLE medical_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  pet_id INT UNSIGNED NOT NULL,
  category_code VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  source_name VARCHAR(200) NOT NULL,
  record_date DATE NULL,
  description TEXT NULL,
  extracted_document_text LONGTEXT NULL,
  extraction_status ENUM(
    'pending',
    'successful',
    'failed_review_needed',
    'image_only_reviewed'
  )
    NOT NULL DEFAULT 'pending',
  publication_status ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
  original_filename VARCHAR(255) NOT NULL,
  storage_key VARCHAR(255) NOT NULL,
  document_mime_type VARCHAR(100) NOT NULL,
  file_size_bytes BIGINT UNSIGNED NOT NULL,
  uploaded_by_admin_id INT UNSIGNED NOT NULL,
  reviewed_by_admin_id INT UNSIGNED NULL,
  uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  published_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_medical_records_storage_key (storage_key),
  KEY idx_medical_records_pet_publication_category
    (pet_id, publication_status, category_code),
  KEY idx_medical_records_pet_record_date (pet_id, record_date),
  KEY idx_medical_records_category (category_code),
  KEY idx_medical_records_uploaded_by (uploaded_by_admin_id),
  KEY idx_medical_records_reviewed_by (reviewed_by_admin_id),

  CONSTRAINT fk_medical_records_pet
    FOREIGN KEY (pet_id) REFERENCES pets(id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  CONSTRAINT fk_medical_records_category
    FOREIGN KEY (category_code)
    REFERENCES medical_record_categories(category_code)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_medical_records_uploaded_by
    FOREIGN KEY (uploaded_by_admin_id) REFERENCES users(id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  CONSTRAINT fk_medical_records_reviewed_by
    FOREIGN KEY (reviewed_by_admin_id) REFERENCES users(id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,

  CONSTRAINT chk_medical_records_file_size
    CHECK (file_size_bytes > 0),
  CONSTRAINT chk_medical_records_supported_mime_type
    CHECK (document_mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  CONSTRAINT chk_medical_records_review_fields
    CHECK (
      (reviewed_by_admin_id IS NULL AND reviewed_at IS NULL)
      OR
      (reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
  CONSTRAINT chk_medical_records_publication
    CHECK (
      (
        publication_status = 'draft'
        AND published_at IS NULL
      )
      OR
      (
        publication_status = 'published'
        AND reviewed_by_admin_id IS NOT NULL
        AND reviewed_at IS NOT NULL
        AND published_at IS NOT NULL
        AND (
          (
            extraction_status = 'successful'
            AND extracted_document_text IS NOT NULL
            AND CHAR_LENGTH(TRIM(extracted_document_text)) > 0
          )
          OR
          (
            extraction_status = 'image_only_reviewed'
            AND category_code = 'x_rays_imaging'
            AND document_mime_type IN ('image/jpeg', 'image/png')
            AND (
              extracted_document_text IS NULL
              OR CHAR_LENGTH(TRIM(extracted_document_text)) = 0
            )
          )
        )
      )
    )
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
