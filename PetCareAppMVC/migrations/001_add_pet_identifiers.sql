USE petcare;

ALTER TABLE pets
  ADD COLUMN avs_licence_number VARCHAR(50) NULL AFTER breed,
  ADD COLUMN microchip_id VARCHAR(30) NULL AFTER avs_licence_number,
  ADD CONSTRAINT uq_pets_avs_licence_number UNIQUE (avs_licence_number),
  ADD CONSTRAINT uq_pets_microchip_id UNIQUE (microchip_id);

DELIMITER //

CREATE TRIGGER trg_pets_require_identifiers_before_insert
BEFORE INSERT ON pets
FOR EACH ROW
BEGIN
  IF NEW.avs_licence_number IS NULL OR TRIM(NEW.avs_licence_number) = '' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'AVS licence number is required for new pets';
  END IF;

  IF NEW.microchip_id IS NULL OR TRIM(NEW.microchip_id) = '' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Microchip ID is required for new pets';
  END IF;
END//

DELIMITER ;
