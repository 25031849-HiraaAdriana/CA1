-- REVIEW ONLY. NOT EXECUTED. Do not run automatically or against petcare
-- without explicit approval, backup, schema inspection and rehearsal.
-- Reconcile against SHOW CREATE TABLE medical_records first: this proposal
-- assumes the names and ENUM definition from migration 002 are still present.
-- It is independent of migration 006 and proposed migration 007.
--
-- Existing published rows retain their original text/status and must continue
-- satisfying their original branch. The new branch requires an explicitly
-- reviewed record, a truthful status and no extracted text; it accepts each
-- existing allowed category and MIME type. Other CHECKs remain in force.
-- MySQL DDL may implicitly commit and acquire a metadata lock. Review actual
-- server version, SQL mode, deployment locking and backup/rollback procedures.
ALTER TABLE medical_records
  DROP CHECK chk_medical_records_publication,
  MODIFY COLUMN extraction_status ENUM(
    'pending', 'successful', 'failed_review_needed', 'image_only_reviewed', 'not_extracted'
  ) NOT NULL DEFAULT 'pending',
  ADD CONSTRAINT chk_medical_records_publication CHECK (
    (publication_status = 'draft' AND published_at IS NULL)
    OR
    (publication_status = 'published'
      AND reviewed_by_admin_id IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND published_at IS NOT NULL
      AND (
        (extraction_status = 'successful'
          AND extracted_document_text IS NOT NULL
          AND CHAR_LENGTH(TRIM(extracted_document_text)) > 0)
        OR
        (extraction_status = 'image_only_reviewed'
          AND category_code = 'x_rays_imaging'
          AND document_mime_type IN ('image/jpeg', 'image/png')
          AND (extracted_document_text IS NULL OR CHAR_LENGTH(TRIM(extracted_document_text)) = 0))
        OR
        (extraction_status = 'not_extracted' AND extracted_document_text IS NULL)
      )
    )
  );
