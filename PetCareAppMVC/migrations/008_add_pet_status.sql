-- PROPOSAL ONLY: review the live pets schema and approve before applying.
-- Adds internal Pomi archival status; existing pets remain active by default.
-- Deceased history is recorded in admin_activity_logs (migration 003).
ALTER TABLE pets
  ADD COLUMN status ENUM('active', 'deceased') NOT NULL DEFAULT 'active' AFTER age,
  ADD KEY idx_pets_owner_status (owner_id, status);
