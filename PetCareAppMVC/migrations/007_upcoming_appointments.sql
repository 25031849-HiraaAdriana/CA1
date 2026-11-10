-- REVIEW ONLY: obtain approval and verify the live schema before applying.
-- This migration is not run automatically by the application.
-- Dates and times represent Singapore local time. Cancelling retains the row.
-- Deleting a pet removes its appointments; actor names remain if a user is deleted.
CREATE TABLE appointments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  pet_id INT UNSIGNED NOT NULL,
  clinic_name VARCHAR(150) NOT NULL,
  appointment_type ENUM('Checkup', 'Vaccination', 'Follow-up', 'Other') NOT NULL,
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  notes VARCHAR(1000) NULL,
  status ENUM('scheduled', 'cancelled') NOT NULL DEFAULT 'scheduled',
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_by_name VARCHAR(100) NOT NULL,
  updated_by_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_appointments_pet_date (pet_id, status, appointment_date, appointment_time),
  KEY idx_appointments_date (status, appointment_date, appointment_time),
  CONSTRAINT fk_appointments_pet FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE,
  CONSTRAINT fk_appointments_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_appointments_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
