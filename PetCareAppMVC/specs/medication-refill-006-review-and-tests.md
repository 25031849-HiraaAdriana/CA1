# Medication refill integrity: proposed follow-up

Status: **proposal only; no database statements have been executed**. Migration
006 and the MVC source are evidence of intended behavior, not proof of the live
schema or existing data. The two SQL files in this directory are deliberately
outside the automatic migration directory. Do not apply them until approved.

## MVC refinement

- Both owner filters treat Paid and Rejected as terminal. A duplicate-key race
  re-reads the key and verifies its identity; other unique failures are not
  silently reported as active requests. Migration 006 still blocks a repeat
  after Paid until the proposed schema change is separately approved and applied.
- Medication draft saves lock and version-check the draft and entries before
  replacing them and recording the audit in one dedicated transaction. A stale
  review must be reloaded. Signed publication uses a dedicated connection for
  entry replacement, publication, audit and signature metadata; its hash uses
  the same canonical entries. Changing the original's identity or pet during
  review is rejected. Medication publication fails closed if signatures or
  audit tables are unavailable.
- A signature file is created before the database transaction; it is not part
  of the transaction. On a confirmed pre-commit failure the controller attempts
  cleanup. If rollback or commit outcome is uncertain, it retains the file and
  reports uncertainty for investigation. Close and cleanup failures are logged.
  A crash can still leave an orphan file; reconcile it against database evidence
  before any approved cleanup.
- Admin review validates CA1 status and price at the model boundary and checks
  the affected row before writing its audit in the same dedicated transaction.
  CA1 does not perform payments.
- Existing originals and signatures are not rewritten. A correction to
  published medication history requires a new reviewed draft and signature.
  The trigger in the proposal protects signed fields without blocking unrelated
  medical-record categories or harmless updates to other metadata.

## Deployment and remediation gates

- Inspect the live MySQL version and `SHOW CREATE TABLE` for all relevant
  tables, actual indexes, checks, triggers, and storage engines. Run the
  read-only preflight only after explicit approval and under a write freeze.
- Investigate each inconsistency with an Admin; never automatically reassign
  ownership or rewrite clinical details, signatures, or audit history.
  Published signature presence is not proof of a matching payload. Review
  historical medication records and their available evidence, particularly
  concurrent publications; the stored hash alone may not reconstruct the
  complete original signed payload.
- Preserve any historical `Paid` rows and investigate their provenance. The
  proposal prevents new CA1 Paid transitions but does not authenticate old
  ones. If remediation is needed, agree on a separately audited approach.
- The new pet-owner foreign key prevents transferring a pet to a different
  owner while any refill history references it. A transfer feature needs an
  explicit historical-ownership design before introducing that feature.
- DDL auto-commits. Back up, test against a disposable clone, use a maintenance
  window, and verify every resulting object. A failed DDL sequence may be
  partially applied; inspect its exact state before a separately approved
  recovery. Never rerun Migration 006.
- Activate the matching MVC changes and schema together while writes are
  frozen. Do not drop the old active index ahead of that coordinated release.

## Tests

The Node test `medicationRefillIntegrityProposal.test.js` uses a fake
connection: it executes **no SQL** and tests existing refill review
commit/rollback sequencing and the owner lookup predicate. It does not prove
MySQL behavior. Existing route tests also mock the model and cannot establish
database integrity. The mock transaction tests exercise stale forms, exact
signed-entry payloads, failures, duplicate keys and CA1 transitions, but do
not reproduce MySQL locking or connection behavior. Run the suite offline
with `NODE_OPTIONS=--require=.\\tests\\support\\denyLiveMysql.js` in Windows
PowerShell (assign it to `$env:NODE_OPTIONS` before `npm test`).

The following are proposed integration tests, to run only with separate
approval on an isolated disposable MySQL database, never on the existing data:

1. Apply the proposal to a clone of the actual schema. Check the expected
   indexes, foreign keys, triggers and enforced CHECK constraints. Attempt
   mismatched `(medical_record_id, pet_id)` and `(pet_id, owner_id)` writes;
   verify rejection without affecting existing rows. Check a pet transfer is
   rejected while request history exists.
2. Submit requests for a draft, another category, a different pet or owner,
   and a mismatched entry/record pair; each must fail. A matching published
   Medication History entry must succeed. Existing request identities cannot
   be rewritten to an ineligible record.
3. For each of Pending, More Information Required and Ready for Test Payment,
   a second active request must fail under concurrent submissions. After
   Rejected and, in an isolated future CA2 fixture with the CA1 guard
   deliberately replaced, after verified Paid, a fresh-key request succeeds.
   The same request key remains idempotent. Verify both owner-facing surfaces.
4. Try inserting, updating, moving and deleting published medication entries
   and rewriting a published Medication History record; each must fail.
   Draft review still works, and all other Passport categories, Shop and
   retired-module behavior are unchanged. Race draft editing against
   publication and assert the stored entry set equals the signed payload.
5. Inject failures at review update, audit insert, signature insert, signature
   storage, commit, rollback, and post-commit response. Verify atomicity,
   accurate error handling, and that committed signatures/files survive.
   Concurrent Admin reviews must not overwrite one another or produce a
   success audit for an unchanged request.
6. Reject `Paid` through CA1 routes, model calls and direct database writes;
   confirm no refill payment endpoint or processing exists. The unrelated
   service-price preparation endpoint remains a mock and must still work.

## CA2 boundary

CA2 is not implemented here. Before enabling `Paid`, replace the CA1 guard in
a separately approved migration and implement server-side gateway verification:
validate authentic sandbox events or server-side gateway responses, gateway
environment, successful state, request/merchant/transaction binding, currency
and exact quoted amount. Deduplicate gateway transaction and event IDs, handle
replay and concurrent callbacks, and atomically persist verified evidence,
the `Ready for Test Payment` to `Paid` transition, and its audit. Never trust a
browser redirect or client-supplied success flag. Test forged, duplicated,
wrong-amount, wrong-currency, wrong-request and failed gateway responses.
