const connection = require('../config/db');
const adminActivityModel = require('./adminActivityModel');
const { assertCurrentMedicationReview } = require('../helpers/medicalReviewVersion');

const database = connection && typeof connection.promise === 'function'
  ? connection.promise()
  : null;
const createTransactionConnection = connection && connection.createPetShopTransactionConnection;
const REQUIRED_TABLES = [
  'medication_entries',
  'medication_refill_requests',
  'admin_activity_logs'
];

async function tableExists(databaseConnection, tableName) {
  const [rows] = await databaseConnection.query('SHOW TABLES LIKE ?', [tableName]);
  return rows.length > 0;
}

async function isFeatureReady() {
  if (!database) return false;
  for (const tableName of REQUIRED_TABLES) {
    if (!(await tableExists(database, tableName))) return false;
  }
  return true;
}

function migrationRequiredError() {
  const error = new Error(
    'Medication refill tables are unavailable. Review and apply migrations/006_medication_refill_demo.sql first.'
  );
  error.code = 'MEDICATION_REFILL_MIGRATION_REQUIRED';
  return error;
}

async function ensureFeatureReady() {
  if (!(await isFeatureReady())) throw migrationRequiredError();
}

async function withTransaction(callback) {
  if (typeof createTransactionConnection !== 'function') {
    throw new Error('A dedicated MySQL connection is required for medication refill transactions.');
  }
  const transactionConnection = createTransactionConnection();
  const transactionDatabase = transactionConnection.promise();
  let transactionStarted = false;
  let committing = false;
  try {
    await transactionDatabase.connect();
    await transactionDatabase.beginTransaction();
    transactionStarted = true;
    const result = await callback(transactionDatabase);
    committing = true;
    await transactionDatabase.commit();
    transactionStarted = false;
    return result;
  } catch (error) {
    if (committing) error.commitOutcomeUnknown = true;
    if (transactionStarted && !committing) {
      try {
        await transactionDatabase.rollback();
      } catch (rollbackError) {
        error.commitOutcomeUnknown = true;
        console.error('Medication refill transaction rollback failed:', rollbackError.code || 'UNKNOWN');
      }
    }
    throw error;
  } finally {
    try {
      await transactionDatabase.end();
    } catch (error) {
      console.error('Medication refill connection close failed:', error.code || 'UNKNOWN');
    }
  }
}

async function replaceDraftMedicationEntries(transactionDatabase, recordId, petId, adminId, entries) {
  await transactionDatabase.query(
    'DELETE FROM medication_entries WHERE medical_record_id = ?',
    [recordId]
  );
  for (const entry of entries) {
    await transactionDatabase.query(
      `INSERT INTO medication_entries (
         medical_record_id, pet_id, medication_name, dosage, frequency,
         start_date, end_date, recorded_by_admin_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [recordId, petId, entry.medicationName, entry.dosage, entry.frequency,
        entry.startDate, entry.endDate, adminId]
    );
  }
}

async function saveDraftMedicationReview(record) {
  await ensureFeatureReady();
  return withTransaction(async transactionDatabase => {
    const [drafts] = await transactionDatabase.query(
      `SELECT id, pet_id, category_code, title, source_name, record_date,
              description, extracted_document_text, extraction_status, storage_key, document_mime_type
       FROM medical_records
       WHERE id = ? AND publication_status = 'draft' FOR UPDATE`,
      [record.id]
    );
    if (!drafts.length) return false;
    await assertCurrentMedicationReview(transactionDatabase, drafts[0], record.expectedVersion);

    const [updated] = await transactionDatabase.query(
      `UPDATE medical_records
       SET category_code = ?, title = ?, source_name = ?, record_date = ?,
           description = ?, extracted_document_text = ?, extraction_status = ?,
           reviewed_by_admin_id = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND publication_status = 'draft'`,
      [
        record.categoryCode,
        record.title,
        record.sourceName,
        record.recordDate,
        record.description,
        record.extractedText,
        record.extractionStatus,
        record.adminId,
        record.id
      ]
    );
    if (updated.affectedRows !== 1) throw new Error('Draft review update failed.');
    await replaceDraftMedicationEntries(transactionDatabase, record.id, drafts[0].pet_id, record.adminId, record.entries);
    await adminActivityModel.logAdminAction({
      adminId: record.adminId,
      adminUsername: record.adminUsername,
      adminName: record.adminName,
      actionType: 'MEDICAL_RECORD_DRAFT_UPDATED',
      targetEntityType: 'medical_record',
      targetEntityId: record.id,
      petId: drafts[0].pet_id,
      petName: record.petName,
      medicalRecordId: record.id,
      medicalRecordTitle: record.title,
      actionResult: 'success',
      metadata: { summary: 'Draft review saved', categoryCode: record.categoryCode }
    }, transactionDatabase);
    return true;
  });
}

async function getDraftMedicationEntries(recordId) {
  await ensureFeatureReady();
  const [entries] = await database.query(
    `SELECT id, medication_name, dosage, frequency, start_date, end_date
     FROM medication_entries
     WHERE medical_record_id = ?
     ORDER BY id`,
    [recordId]
  );
  return entries;
}

async function getPublishedMedicationEntriesForOwnerPet(petId, ownerId) {
  await ensureFeatureReady();
  const [entries] = await database.query(
    `SELECT me.id, me.medical_record_id, me.pet_id, me.medication_name,
            me.dosage, me.frequency, me.start_date, me.end_date, me.refill_quantity_unit,
            mr.title AS record_title, mr.record_date, mr.source_name,
            active_request.status AS active_request_status,
            active_request.id AS active_request_id,
            last_request.id AS last_request_id, last_request.status AS last_request_status
     FROM medication_entries me
     INNER JOIN medical_records mr ON mr.id = me.medical_record_id
     INNER JOIN pets p ON p.id = mr.pet_id AND p.id = me.pet_id
     LEFT JOIN (
       SELECT id, medication_entry_id, status
       FROM medication_refill_requests
       WHERE owner_id = ? AND status NOT IN ('Rejected', 'Paid')
     ) active_request ON active_request.medication_entry_id = me.id
     LEFT JOIN medication_refill_requests last_request ON last_request.id = (
       SELECT rr.id FROM medication_refill_requests rr
       WHERE rr.medication_entry_id = me.id AND rr.owner_id = ?
       ORDER BY rr.id DESC LIMIT 1
     )
     WHERE p.id = ? AND p.owner_id = ? AND p.status = 'active'
       AND mr.publication_status = 'published'
       AND mr.category_code = 'medication_history'
     ORDER BY mr.record_date DESC, me.id DESC`,
    [ownerId, ownerId, petId, ownerId]
  );
  return entries;
}

async function getMedicationEntryForOwnerPet(medicationEntryId, petId, ownerId) {
  await ensureFeatureReady();
  const [entries] = await database.query(
    `SELECT me.id, me.medical_record_id, me.pet_id, me.medication_name,
            me.dosage, me.frequency, me.start_date, me.end_date, me.refill_quantity_unit,
            mr.title AS record_title, mr.record_date, mr.source_name, p.name AS pet_name
     FROM medication_entries me
     INNER JOIN medical_records mr ON mr.id = me.medical_record_id
     INNER JOIN pets p ON p.id = mr.pet_id AND p.id = me.pet_id
     WHERE me.id = ? AND p.id = ? AND p.owner_id = ? AND p.status = 'active'
       AND mr.publication_status = 'published'
       AND mr.category_code = 'medication_history'
     LIMIT 1`,
    [medicationEntryId, petId, ownerId]
  );
  return entries[0] || null;
}

async function getActiveRefillRequest(medicationEntryId, ownerId) {
  await ensureFeatureReady();
  const [requests] = await database.query(
    `SELECT id, status
     FROM medication_refill_requests
     WHERE medication_entry_id = ? AND owner_id = ?
       AND status NOT IN ('Rejected', 'Paid')
     ORDER BY id DESC
     LIMIT 1`,
    [medicationEntryId, ownerId]
  );
  return requests[0] || null;
}

async function getOwnerRefillRequests(petId, ownerId) {
  await ensureFeatureReady();
  const [requests] = await database.query(
    `SELECT rr.id, rr.status, rr.message, rr.demo_price_cents,
            rr.refill_reason, rr.requested_quantity, rr.requested_quantity_unit,
            rr.admin_review_note, rr.created_at, rr.reviewed_at,
            me.medication_name, me.dosage, me.frequency,
            mr.id AS medical_record_id, mr.title AS record_title
     FROM medication_refill_requests rr
     INNER JOIN medication_entries me ON me.id = rr.medication_entry_id
     INNER JOIN medical_records mr ON mr.id = rr.medical_record_id
     WHERE rr.pet_id = ? AND rr.owner_id = ?
       AND EXISTS (SELECT 1 FROM pets p WHERE p.id = rr.pet_id AND p.status = 'active')
     ORDER BY rr.created_at DESC, rr.id DESC`,
    [petId, ownerId]
  );
  return requests;
}

async function getOwnerAcceptedDemoRefills(ownerId) {
  await ensureFeatureReady();
  const [requests] = await database.query(
    `SELECT rr.id, rr.pet_id, rr.demo_price_cents, rr.requested_quantity,
            rr.requested_quantity_unit, p.name AS pet_name,
            me.medication_name
     FROM medication_refill_requests rr
     INNER JOIN pets p ON p.id = rr.pet_id AND p.owner_id = rr.owner_id
     INNER JOIN medication_entries me ON me.id = rr.medication_entry_id
       AND me.medical_record_id = rr.medical_record_id AND me.pet_id = rr.pet_id
     WHERE rr.owner_id = ? AND p.status = 'active'
       AND rr.status = 'Ready for Test Payment'
     ORDER BY rr.id DESC`,
    [ownerId]
  );
  return requests;
}

async function createOwnerRefillRequest(request) {
  await ensureFeatureReady();
  const checkExisting = match => {
    if (String(match.owner_id) !== String(request.ownerId) ||
        String(match.pet_id) !== String(request.petId) ||
        String(match.medication_entry_id) !== String(request.medicationEntryId)) {
      const error = new Error('The request form token is invalid.');
      error.code = 'INVALID_REQUEST_KEY';
      throw error;
    }
    return { id: match.id, duplicateSubmission: true };
  };
  try {
    return await withTransaction(async transactionDatabase => {
      const [existing] = await transactionDatabase.query(
        `SELECT id, owner_id, pet_id, medication_entry_id
         FROM medication_refill_requests
         WHERE request_key = ?
         LIMIT 1`,
        [request.requestKey]
      );
      if (existing.length) {
        return checkExisting(existing[0]);
      }

      const [result] = await transactionDatabase.query(
        `INSERT INTO medication_refill_requests (
           medication_entry_id, medical_record_id, pet_id, owner_id,
           request_key, refill_reason, requested_quantity, requested_quantity_unit, status
         )
         SELECT me.id, mr.id, p.id, p.owner_id, ?, ?, ?, ?, 'Pending'
         FROM medication_entries me
         INNER JOIN medical_records mr ON mr.id = me.medical_record_id
         INNER JOIN pets p ON p.id = mr.pet_id AND p.id = me.pet_id
         WHERE me.id = ? AND mr.id = ? AND p.id = ? AND p.owner_id = ?
           AND mr.publication_status = 'published'
           AND mr.category_code = 'medication_history'
           AND p.status = 'active'
           AND (CASE WHEN me.refill_quantity_unit IS NULL OR TRIM(me.refill_quantity_unit) = ''
             THEN ? IN ('tablets', 'capsules', 'mL', 'sachets', 'doses', 'units')
             ELSE BINARY TRIM(me.refill_quantity_unit) = BINARY ? END)`,
        [
          request.requestKey,
          request.reason,
          request.quantity,
          request.unit,
          request.medicationEntryId,
          request.recordId,
          request.petId,
          request.ownerId,
          request.unit,
          request.unit
        ]
      );
      if (result.affectedRows !== 1) {
        const error = new Error('Medication not found for this pet owner.');
        error.code = 'MEDICATION_NOT_FOUND';
        throw error;
      }
      return { id: result.insertId, duplicateSubmission: false };
    });
  } catch (error) {
    if (error.commitOutcomeUnknown) throw error;
    if (error.code === 'ER_DUP_ENTRY') {
      const [existing] = await database.query(
        `SELECT id, owner_id, pet_id, medication_entry_id
         FROM medication_refill_requests WHERE request_key = ? LIMIT 1`,
        [request.requestKey]
      );
      if (existing.length) return checkExisting(existing[0]);
      const [active] = await database.query(
        `SELECT id FROM medication_refill_requests
         WHERE owner_id = ? AND medication_entry_id = ?
           AND status NOT IN ('Rejected', 'Paid') LIMIT 1`,
        [request.ownerId, request.medicationEntryId]
      );
      if (!active.length) throw error;
      const duplicateError = new Error('An active refill request already exists for this medication.');
      duplicateError.code = 'ACTIVE_REQUEST_EXISTS';
      throw duplicateError;
    }
    throw error;
  }
}

async function getAdminRefillRequests() {
  await ensureFeatureReady();
  const [requests] = await database.query(
    `SELECT rr.id, rr.status, rr.message, rr.demo_price_cents,
            rr.refill_reason, rr.requested_quantity, rr.requested_quantity_unit,
            rr.admin_review_note, rr.created_at, rr.reviewed_at,
            rr.owner_id, owner.name AS owner_name,
            p.id AS pet_id, p.name AS pet_name, p.status AS pet_status,
            me.id AS medication_entry_id, me.medication_name, me.dosage, me.frequency,
            mr.id AS medical_record_id, mr.title AS record_title
     FROM medication_refill_requests rr
     INNER JOIN users owner ON owner.id = rr.owner_id
     INNER JOIN pets p ON p.id = rr.pet_id AND p.owner_id = rr.owner_id
     INNER JOIN medication_entries me ON me.id = rr.medication_entry_id
     INNER JOIN medical_records mr ON mr.id = rr.medical_record_id
     ORDER BY FIELD(rr.status, 'Pending', 'More Information Required',
       'Ready for Test Payment', 'Rejected', 'Paid'), rr.created_at DESC`,
    []
  );
  return requests;
}

async function updateAdminRefillRequest(update) {
  const statuses = ['Rejected', 'Ready for Test Payment'];
  if (!update || !statuses.includes(update.status) ||
      !update.requestId || !update.adminId ||
      typeof update.adminUsername !== 'string' || !update.adminUsername.trim() ||
      typeof update.adminName !== 'string' || !update.adminName.trim() ||
      (update.reviewNote != null && (typeof update.reviewNote !== 'string' || update.reviewNote.length > 500)) ||
      (update.status === 'Ready for Test Payment'
        ? !Number.isSafeInteger(update.demoPriceCents) || update.demoPriceCents < 1 || update.demoPriceCents > 10000000
        : update.demoPriceCents != null)) {
    throw new Error('Invalid CA1 refill review.');
  }
  await ensureFeatureReady();
  return withTransaction(async transactionDatabase => {
    const [requests] = await transactionDatabase.query(
      `SELECT rr.id, rr.status, rr.owner_id, rr.pet_id, rr.medical_record_id,
              p.name AS pet_name, p.status AS pet_status, mr.title AS record_title
       FROM medication_refill_requests rr
       INNER JOIN pets p ON p.id = rr.pet_id AND p.owner_id = rr.owner_id
       INNER JOIN medical_records mr ON mr.id = rr.medical_record_id
       WHERE rr.id = ? AND rr.status IN ('Pending', 'More Information Required')
         AND p.status = 'active'
       FOR UPDATE`,
      [update.requestId]
    );
    if (!requests.length) return false;
    const request = requests[0];

    const [updated] = await transactionDatabase.query(
      `UPDATE medication_refill_requests
       SET status = ?, demo_price_cents = ?, admin_review_note = ?,
           reviewed_by_admin_id = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('Pending', 'More Information Required')`,
      [
        update.status,
        update.status === 'Ready for Test Payment' ? update.demoPriceCents : null,
        update.reviewNote,
        update.adminId,
        update.requestId
      ]
    );
    if (updated.affectedRows !== 1) throw new Error('Refill review update failed.');

    const [auditResult] = await transactionDatabase.query(
      `INSERT INTO admin_activity_logs (
         admin_id, admin_username, admin_name, action_type, target_entity_type,
         target_entity_id, pet_id, pet_name, medical_record_id, medical_record_title,
         action_result, metadata
       ) VALUES (?, ?, ?, 'MEDICATION_REFILL_DEMO_REVIEWED',
         'medication_refill_request', ?, ?, ?, ?, ?, 'success', ?)`,
      [
        update.adminId,
        update.adminUsername,
        update.adminName,
        update.requestId,
        request.pet_id,
        request.pet_name,
        request.medical_record_id,
        request.record_title,
        JSON.stringify({
          status: update.status,
          demoPriceCents: update.status === 'Ready for Test Payment'
            ? update.demoPriceCents
            : null,
          reviewNote: update.reviewNote
        })
      ]
    );
    if (!auditResult.insertId) throw new Error('Refill review audit insertion failed.');
    return true;
  });
}

module.exports = {
  isFeatureReady,
  migrationRequiredError,
  saveDraftMedicationReview,
  replaceDraftMedicationEntries,
  getDraftMedicationEntries,
  getPublishedMedicationEntriesForOwnerPet,
  getMedicationEntryForOwnerPet,
  getActiveRefillRequest,
  getOwnerRefillRequests,
  getOwnerAcceptedDemoRefills,
  createOwnerRefillRequest,
  getAdminRefillRequests,
  updateAdminRefillRequest
};
