-- PROPOSAL ONLY. NOT EXECUTED. Do not place in the automatic migration path.
-- WARNING: the user reports uq_medical_records_id_pet_refill already exists
-- in the target database. This file must NOT be run as written. Inspect the
-- live schema only with separate approval and prepare a reconciled migration
-- after verifying every remaining index, constraint and trigger.
-- Requires approval, a tested backup, a write freeze and clean preflight.
-- Confirm the exact MySQL version, schema, CHECK enforcement, existing
-- triggers and privileges on a disposable clone first. DDL implicitly commits:
-- a failure can leave a partially installed migration. Inspect each object
-- before recovery; do not blindly rerun this file. No data repair is included.
--
-- Coordinate the MVC changes and tests in the accompanying test plan before
-- release. Before this migration, Migration 006 still blocks repeats after Paid
-- even though the MVC filters now consider Paid terminal.

ALTER TABLE medical_records
  ADD UNIQUE KEY uq_medical_records_id_pet_refill (id, pet_id);

ALTER TABLE pets
  ADD UNIQUE KEY uq_pets_id_owner_refill (id, owner_id);

ALTER TABLE medication_entries
  ADD CONSTRAINT fk_medication_entries_record_pet
    FOREIGN KEY (medical_record_id, pet_id)
    REFERENCES medical_records (id, pet_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Deliberately prevents ownership transfer while any request history refers
-- to the current owner. A transfer policy requires a separate reviewed design.
ALTER TABLE medication_refill_requests
  ADD CONSTRAINT fk_medication_refill_pet_owner
    FOREIGN KEY (pet_id, owner_id) REFERENCES pets (id, owner_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Paid and Rejected are terminal. More Information Required and Ready for
-- Test Payment remain active. Keep the old generated column for compatibility.
ALTER TABLE medication_refill_requests
  ADD COLUMN active_request_v2 TINYINT GENERATED ALWAYS AS (
    CASE WHEN status IN ('Rejected', 'Paid') THEN NULL ELSE 1 END
  ) STORED,
  ADD UNIQUE KEY uq_medication_refill_active_v2
    (owner_id, medication_entry_id, active_request_v2);

-- Execute only after the new index exists and coordinated MVC changes are ready.
ALTER TABLE medication_refill_requests
  DROP INDEX uq_medication_refill_active_request;

-- Trigger definitions use the mysql client DELIMITER command. Confirm support
-- in the chosen migration runner and test locking/concurrency on the clone.
DELIMITER $$

CREATE TRIGGER medication_entries_draft_insert
BEFORE INSERT ON medication_entries FOR EACH ROW
BEGIN
  DECLARE record_status VARCHAR(20);
  SELECT publication_status INTO record_status FROM medical_records
    WHERE id = NEW.medical_record_id FOR UPDATE;
  IF record_status IS NULL OR record_status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Medication entries require a draft record';
  END IF;
END$$

CREATE TRIGGER medication_entries_draft_update
BEFORE UPDATE ON medication_entries FOR EACH ROW
BEGIN
  DECLARE old_status VARCHAR(20);
  DECLARE new_status VARCHAR(20);
  SELECT publication_status INTO old_status FROM medical_records
    WHERE id = OLD.medical_record_id FOR UPDATE;
  SELECT publication_status INTO new_status FROM medical_records
    WHERE id = NEW.medical_record_id FOR UPDATE;
  IF old_status IS NULL OR new_status IS NULL OR old_status <> 'draft' OR new_status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Published medication entries are immutable';
  END IF;
END$$

CREATE TRIGGER medication_entries_draft_delete
BEFORE DELETE ON medication_entries FOR EACH ROW
BEGIN
  DECLARE record_status VARCHAR(20);
  SELECT publication_status INTO record_status FROM medical_records
    WHERE id = OLD.medical_record_id FOR UPDATE;
  IF record_status IS NULL OR record_status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Published medication entries are immutable';
  END IF;
END$$

-- Corrections require a new reviewed record, not rewriting a published one.
CREATE TRIGGER medication_record_published_immutable
BEFORE UPDATE ON medical_records FOR EACH ROW
BEGIN
  IF OLD.publication_status = 'published' AND (
       (OLD.category_code <> 'medication_history' AND NEW.category_code = 'medication_history')
       OR (OLD.category_code = 'medication_history' AND (
         NOT (NEW.pet_id <=> OLD.pet_id)
         OR NOT (NEW.category_code <=> OLD.category_code)
         OR NOT (NEW.title <=> OLD.title)
         OR NOT (NEW.source_name <=> OLD.source_name)
         OR NOT (NEW.record_date <=> OLD.record_date)
         OR NOT (NEW.description <=> OLD.description)
         OR NOT (NEW.extracted_document_text <=> OLD.extracted_document_text)
         OR NOT (NEW.extraction_status <=> OLD.extraction_status)
         OR NOT (NEW.publication_status <=> OLD.publication_status)
         OR NOT (NEW.original_filename <=> OLD.original_filename)
         OR NOT (NEW.storage_key <=> OLD.storage_key)
         OR NOT (NEW.document_mime_type <=> OLD.document_mime_type)
         OR NOT (NEW.file_size_bytes <=> OLD.file_size_bytes)
         OR NOT (NEW.uploaded_by_admin_id <=> OLD.uploaded_by_admin_id)
         OR NOT (NEW.reviewed_by_admin_id <=> OLD.reviewed_by_admin_id)
         OR NOT (NEW.uploaded_at <=> OLD.uploaded_at)
         OR NOT (NEW.reviewed_at <=> OLD.reviewed_at)
         OR NOT (NEW.published_at <=> OLD.published_at)
       ))
     ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Published medication records are immutable';
  END IF;
END$$

CREATE TRIGGER medication_refill_eligible_insert
BEFORE INSERT ON medication_refill_requests FOR EACH ROW
BEGIN
  DECLARE record_status VARCHAR(20);
  DECLARE record_category VARCHAR(50);
  SELECT publication_status, category_code INTO record_status, record_category
    FROM medical_records WHERE id = NEW.medical_record_id;
  IF NEW.status <> 'Pending' OR record_status IS NULL
     OR record_status <> 'published' OR record_category <> 'medication_history' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Refill requires a published medication record and Pending status';
  END IF;
END$$

-- CA1 has no verified gateway: direct attempts to set Paid are rejected.
-- CA2 must replace this guard as part of a separately reviewed gateway migration.
CREATE TRIGGER medication_refill_ca1_update
BEFORE UPDATE ON medication_refill_requests FOR EACH ROW
BEGIN
  IF NOT (NEW.medication_entry_id <=> OLD.medication_entry_id)
     OR NOT (NEW.medical_record_id <=> OLD.medical_record_id)
     OR NOT (NEW.pet_id <=> OLD.pet_id)
     OR NOT (NEW.owner_id <=> OLD.owner_id)
     OR NOT (NEW.request_key <=> OLD.request_key) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Refill request identity is immutable';
  END IF;
  IF NEW.status = 'Paid' AND OLD.status <> 'Paid' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Paid is unavailable in CA1';
  END IF;
  IF OLD.status IN ('Rejected', 'Paid') AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Terminal refill status is immutable';
  END IF;
  IF NEW.status <> OLD.status AND
     (OLD.status NOT IN ('Pending', 'More Information Required')
      OR NEW.status NOT IN ('More Information Required', 'Rejected', 'Ready for Test Payment')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid CA1 refill transition';
  END IF;
END$$

DELIMITER ;
