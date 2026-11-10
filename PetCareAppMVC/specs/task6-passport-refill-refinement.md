# Task 6 Passport and refill refinement

This is a proposal and staging note, not a deployment instruction. No SQL or
migration was executed for this update. The database is reported to contain
`uq_medical_records_id_pet_refill`; the earlier 007 proposal must not be run as
written. Inspect the actual schema only with separate approval and reconcile
each remaining 007 object before preparing a final migration.

## Refill update

- The four refill columns were reported added by the user; this implementation
  did not inspect or change the database. New requests require a reason,
  positive integer quantity and unit on the medical record detail page.
  A documented unit must match the entry. When no unit was documented, the
  owner must select a clearly labelled demo unit; it is not veterinary verified
  and does not change the signed record.
- The separate demo cart displays new quantities and marks historical requests
  without quantities as not recorded. Collection/delivery choices live in the
  current session only; they do not represent an order or actual delivery.

## What remains blocked
- Existing publication CHECK constraints require reviewed extracted text (or
  the narrow image-only radiology exception). Medical OCR is still performed
  and visible in the existing Admin review flow until its replacement is
  approved and implemented. Do not remove the field, fabricate extraction
  text, or bypass signature review in order to publish.
- The management screen now combines pet search and draft upload, but the
  structured-medication entry, document preview and signed publication remain
  on the existing separate review screen. A complete single-screen workflow
  needs safe staged-upload and concurrency design; it is not implemented.

## Schema and rollout

`task6-passport-refill-additive-proposal.sql` is illustrative, not a migration
to run. In particular, replacing a CHECK is not purely additive. Verify the
live constraint and every legacy branch, the MySQL version and trigger
interactions on a disposable clone; DDL can partially commit. Preserve original
files, OCR text, signatures and audits. The manual-review flag must be set
only by the transactional signed Admin workflow; do not trust a client flag.
The existing 007 triggers must also protect new signed fields and the unit,
while accepting legacy data. The proposed nullable columns alone do not ensure
that new requests contain a reason and quantity. The MVC validates these fields
and rechecks the owner, record, publication and unit in the insert; legacy demo
unit choices are limited to the explicit selection list.

## Future CA2 payment window

Do not start a deadline in CA1. In CA2 add a nullable server-side UTC acceptance
timestamp and expiry timestamp, set once in the same transaction as acceptance
and audit, and snapshot the quote. Legacy accepted requests need an explicit
policy; do not retroactively assume their deadline. Expose a countdown as
display only; the server must check UTC expiry on every payment attempt.
In a transaction, lock the request and verify status, deadline, exact amount,
currency and authentic sandbox gateway result, with unique event/transaction
identifiers. The expiry worker must use the same lock and transition rules.
If optional demo stock tracking is later added, release its reservation once
on expiry in that transaction. Never claim real stock is reserved. Payment
and expiry race tests require an isolated MySQL instance and a sandbox gateway.

## Manual checks after approval

Test phone and desktop layouts in a browser, including keyboard navigation,
private-original authorization, owner isolation, status history, cart choice
switching and both original-file links. Test the final schema and concurrent
publication/refill workflows on a disposable clone before any live rollout.
