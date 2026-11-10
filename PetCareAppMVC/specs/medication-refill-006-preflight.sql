-- PROPOSAL ONLY: do not run without explicit approval.
-- Read-only checks. Run against the intended database during a write freeze,
-- before considering the corrective proposal. Investigate every returned ID.
-- Protect the results as sensitive administrative data.

SELECT VERSION() AS mysql_version, DATABASE() AS selected_database;

SELECT table_name, engine
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_name IN ('users', 'pets', 'medical_records', 'medication_entries',
                     'medication_refill_requests', 'admin_activity_logs',
                     'medical_record_signatures');

SELECT table_name, trigger_name, action_timing, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = DATABASE()
  AND event_object_table IN ('pets', 'medical_records', 'medication_entries',
                             'medication_refill_requests');

-- Also capture SHOW CREATE TABLE for each table listed above and compare
-- columns, types, indexes, foreign keys, checks, collation, and engines with
-- migrations 002, 003 and 006; CREATE TABLE IF NOT EXISTS can hide drift.

SELECT me.id AS medication_entry_id
FROM medication_entries me
LEFT JOIN medical_records mr ON mr.id = me.medical_record_id
LEFT JOIN pets p ON p.id = me.pet_id
WHERE mr.id IS NULL OR p.id IS NULL OR NOT (me.pet_id <=> mr.pet_id);

SELECT me.id AS medication_entry_id
FROM medication_entries me
JOIN medical_records mr ON mr.id = me.medical_record_id
WHERE mr.category_code <> 'medication_history';

SELECT rr.id AS request_id
FROM medication_refill_requests rr
LEFT JOIN pets p ON p.id = rr.pet_id
LEFT JOIN users u ON u.id = rr.owner_id
LEFT JOIN medication_entries me ON me.id = rr.medication_entry_id
LEFT JOIN medical_records mr ON mr.id = rr.medical_record_id
WHERE p.id IS NULL OR u.id IS NULL OR me.id IS NULL OR mr.id IS NULL
   OR NOT (rr.owner_id <=> p.owner_id)
   OR NOT (rr.medical_record_id <=> me.medical_record_id)
   OR NOT (rr.pet_id <=> me.pet_id)
   OR NOT (rr.pet_id <=> mr.pet_id);

-- Current state cannot prove eligibility at the time of an old request.
SELECT rr.id AS request_id
FROM medication_refill_requests rr
JOIN medical_records mr ON mr.id = rr.medical_record_id
WHERE mr.publication_status <> 'published'
   OR mr.category_code <> 'medication_history';

SELECT owner_id, medication_entry_id, COUNT(*) AS active_count
FROM medication_refill_requests
WHERE status NOT IN ('Rejected', 'Paid')
GROUP BY owner_id, medication_entry_id
HAVING COUNT(*) > 1;

-- Preserve these rows. CA1 has no gateway evidence; investigate provenance.
SELECT id AS request_id
FROM medication_refill_requests
WHERE status = 'Paid';

SELECT rr.id AS request_id
FROM medication_refill_requests rr
LEFT JOIN admin_activity_logs al
  ON al.target_entity_type = 'medication_refill_request'
 AND al.target_entity_id = rr.id
 AND al.action_type = 'MEDICATION_REFILL_DEMO_REVIEWED'
 AND al.action_result = 'success'
WHERE rr.status <> 'Pending' AND al.id IS NULL;

-- Find published medication records without an approved signature.
-- Presence alone does not establish that the signature matches current data.
SELECT mr.id AS medical_record_id
FROM medical_records mr
LEFT JOIN medical_record_signatures s
  ON s.medical_record_id = mr.id AND s.approval_status = 'approved'
WHERE mr.category_code = 'medication_history'
  AND mr.publication_status = 'published'
  AND s.id IS NULL;
