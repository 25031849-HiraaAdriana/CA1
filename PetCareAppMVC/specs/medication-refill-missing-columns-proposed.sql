-- CA2 DATABASE PROPOSAL FOR REVIEW ONLY. Do not execute automatically.
-- This proposal does not add payment functionality.
--
-- The admin list, owner history, cart, and request submission require these
-- four columns. A read-only inspection found them absent in the target schema.
-- Recheck the target schema before any deployment: this is not idempotent.
-- Obtain approval, take and verify a backup, and test on an isolated clone.
-- MySQL DDL implicitly commits; if a statement fails, inspect the schema
-- before recovery. Do not rerun migration 006 or the proposed 007 wholesale.
--
-- Legacy records retain NULLs; no historical medical or refill values are
-- backfilled. ALTER TABLE may still rebuild or lock a table; plan downtime.
-- New requests are validated in the MVC and must provide details.
-- The CHECK also prevents partially populated or non-positive details, but
-- allows all-NULL legacy rows; it does not by itself require new details or
-- enforce agreement with the medication entry's documented unit.
-- ENUM validation also depends on MySQL SQL mode; test the deployment mode.

ALTER TABLE medication_entries
  ADD COLUMN refill_quantity_unit VARCHAR(40) NULL;

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

-- This does not install the separately proposed 007 foreign keys, indexes or
-- triggers, or change publication constraints. Review those independently;
-- their absence is not resolved by these column additions.
-- In particular, the existing active-request key treats Paid as active,
-- whereas the MVC treats Paid as terminal. Do not alter it without a separate
-- approved CA2 integrity and payment design.
