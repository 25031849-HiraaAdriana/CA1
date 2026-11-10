-- PROPOSAL ONLY: do not run without reviewing the live pets schema and triggers.
-- Assumes migration 001 is installed exactly as checked in: both identifiers
-- are nullable and retain their unique indexes. No existing rows are changed.
-- MySQL trigger DDL commits implicitly. Schedule a write pause and a rollback
-- plan: there is a gap between dropping the old trigger and creating the new one.
-- The original trigger definition is in 001_add_pet_identifiers.sql.

DROP TRIGGER trg_pets_require_identifiers_before_insert;

DELIMITER //
CREATE TRIGGER trg_pets_require_identifiers_before_insert
BEFORE INSERT ON pets
FOR EACH ROW
BEGIN
  IF NEW.species IS NULL OR LOWER(TRIM(NEW.species)) NOT IN ('dog', 'cat', 'rabbit', 'hamster', 'guinea pig') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Unsupported pet species';
  END IF;

  IF LOWER(TRIM(NEW.species)) IN ('dog', 'cat') THEN
    IF NEW.avs_licence_number IS NULL OR TRIM(NEW.avs_licence_number) = '' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AVS licence number is required for dogs and cats';
    END IF;
    IF NEW.microchip_id IS NULL OR TRIM(NEW.microchip_id) = '' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Microchip ID is required for dogs and cats';
    END IF;
  ELSE
    IF NEW.avs_licence_number IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AVS licence number must be NULL for this species';
    END IF;
    IF NEW.microchip_id IS NOT NULL AND TRIM(NEW.microchip_id) = '' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Absent Microchip ID must be NULL';
    END IF;
  END IF;
END//
DELIMITER ;
