
USE petcare;

ALTER TABLE pets
  ADD COLUMN status
    ENUM('active', 'deceased')
    NOT NULL DEFAULT 'active'
    AFTER age,
  ADD KEY idx_pets_owner_status (owner_id, status);


SELECT id, name, species, status
FROM petcare.pets;
