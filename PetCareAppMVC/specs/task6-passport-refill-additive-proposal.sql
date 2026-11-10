-- REVIEW ONLY. NOT EXECUTED. Do not run against live data without approval.
-- Confirm actual SHOW CREATE TABLE, CHECK enforcement, triggers and version.
-- Take a tested backup and verify on an isolated clone before any deployment.
-- MySQL DDL implicitly commits; inspect each step if a later statement fails.
-- The existing uq_medical_records_id_pet_refill is already present: do not
-- re-add it, rerun Migration 006, or run the earlier 007 proposal blindly.
-- This file is not an executable migration and must not run automatically.

-- A unit is manually documented by the reviewing Admin, never inferred from
-- dose. Historical entries have NULL; correct through a newly signed record.
ALTER TABLE medication_entries
  ADD COLUMN refill_quantity_unit VARCHAR(40) NULL;

-- Existing requests retain NULLs; no historical notes are changed. New MVC
-- validation must require all three fields, positive quantity and a unit that
-- matches the reviewed entry. A future separate design may add a new flag or
-- enforce this invariant in the database for new INSERTs.
ALTER TABLE medication_refill_requests
  ADD COLUMN refill_reason ENUM('Lost/Misplaced', 'Running Low',
    'Insufficient Supply', 'Other') NULL,
  ADD COLUMN requested_quantity INT UNSIGNED NULL,
  ADD COLUMN requested_quantity_unit VARCHAR(40) NULL,
  ADD CONSTRAINT chk_refill_quantity_details CHECK (
    (refill_reason IS NULL AND requested_quantity IS NULL AND requested_quantity_unit IS NULL)
    OR
    (refill_reason IS NOT NULL AND requested_quantity IS NOT NULL
     AND requested_quantity > 0 AND requested_quantity_unit IS NOT NULL
     AND CHAR_LENGTH(TRIM(requested_quantity_unit)) > 0)
  );

-- Manual review replaces the historical text requirement only for newly
-- reviewed records. Preserve old text/status and all existing record rows.
-- Coordinate with a transactional signed-publication MVC implementation;
-- the flag must only be set by that reviewed workflow, not by user input.
ALTER TABLE medical_records
  ADD COLUMN manual_review_completed TINYINT(1) NOT NULL DEFAULT 0;

-- Replace only after verifying the actual constraint name and full definition.
-- Preserve every legacy valid branch and add the manual-review branch.
ALTER TABLE medical_records
  DROP CHECK chk_medical_records_publication,
  ADD CONSTRAINT chk_medical_records_publication CHECK (
    (publication_status = 'draft' AND published_at IS NULL)
    OR
    (publication_status = 'published'
     AND reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL
     AND published_at IS NOT NULL
     AND (
       (extraction_status = 'successful' AND extracted_document_text IS NOT NULL
        AND CHAR_LENGTH(TRIM(extracted_document_text)) > 0)
       OR (extraction_status = 'image_only_reviewed'
           AND category_code = 'x_rays_imaging'
           AND document_mime_type IN ('image/jpeg', 'image/png')
           AND (extracted_document_text IS NULL OR CHAR_LENGTH(TRIM(extracted_document_text)) = 0))
       OR manual_review_completed = 1
     ))
  );

-- The 24-hour payment window is deliberately absent in CA1. CA2 needs a
-- separate reviewed gateway-evidence and atomic expiry/payment design.
