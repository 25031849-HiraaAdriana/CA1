const crypto = require('crypto');
const connection = require('../config/db');
const { assertCurrentMedicationReview, medicalReviewVersion } = require('../helpers/medicalReviewVersion');

const database = connection && typeof connection.promise === 'function'
  ? connection.promise()
  : null;

function safeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clampString(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

async function tableExists(tableName) {
  if (!database) return false;

  try {
    const [rows] = await database.query('SHOW TABLES LIKE ?', [tableName]);
    return rows.length > 0;
  } catch (error) {
    return false;
  }
}

async function isFeatureReady() {
  if (!database) return false;
  const logsReady = await tableExists('admin_activity_logs');
  const signaturesReady = await tableExists('medical_record_signatures');
  return logsReady && signaturesReady;
}

async function logAdminAction(logEntry, transactionDatabase = null) {
  if ((!database && !transactionDatabase) || !logEntry) return null;

  const activityReady = transactionDatabase || await tableExists('admin_activity_logs');
  if (!activityReady) return null;

  const action = {
    adminId: Number.isInteger(logEntry.adminId) ? logEntry.adminId : null,
    adminUsername: clampString(logEntry.adminUsername || logEntry.admin_username || null, 50),
    adminName: clampString(logEntry.adminName || logEntry.admin_name || null, 100),
    actionType: clampString(logEntry.actionType || logEntry.action_type || 'ADMIN_ACTION', 80),
    targetEntityType: clampString(logEntry.targetEntityType || logEntry.target_entity_type || 'system', 80),
    targetEntityId: logEntry.targetEntityId || logEntry.target_entity_id || null,
    petId: logEntry.petId || logEntry.pet_id || null,
    petName: clampString(logEntry.petName || logEntry.pet_name || null, 80),
    medicalRecordId: logEntry.medicalRecordId || logEntry.medical_record_id || null,
    medicalRecordTitle: clampString(logEntry.medicalRecordTitle || logEntry.medical_record_title || null, 200),
    actionResult: logEntry.actionResult || logEntry.action_result || 'success',
    metadata: logEntry.metadata ? JSON.stringify(logEntry.metadata) : null,
    createdAt: logEntry.createdAt || new Date()
  };

  const [result] = await (transactionDatabase || database).query(
    `INSERT INTO admin_activity_logs (
      admin_id, admin_username, admin_name, action_type, target_entity_type, target_entity_id,
      pet_id, pet_name, medical_record_id, medical_record_title, action_result, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      action.adminId,
      action.adminUsername,
      action.adminName,
      action.actionType,
      action.targetEntityType,
      action.targetEntityId,
      action.petId,
      action.petName,
      action.medicalRecordId,
      action.medicalRecordTitle,
      action.actionResult,
      action.metadata,
      action.createdAt
    ]
  );

  if (!result || !result.insertId) {
    throw new Error('Admin activity log insertion failed.');
  }

  return result.insertId;
}

async function recordSignedApproval(approvalEntry, transactionDatabase = null) {
  if (!database && !transactionDatabase) return null;

  const signaturesReady = transactionDatabase || await tableExists('medical_record_signatures');
  if (!signaturesReady) return null;

  if (!approvalEntry || !approvalEntry.medicalRecordId || !approvalEntry.adminId || !approvalEntry.signatureStorageKey || !approvalEntry.reviewVersionHash || !approvalEntry.originalDocumentFingerprint || !approvalEntry.relatedAuditActivityId) {
    throw new Error('Signed approval metadata is incomplete.');
  }

  const signatureEntry = {
    medicalRecordId: approvalEntry.medicalRecordId,
    adminId: approvalEntry.adminId,
    signatureStorageKey: String(approvalEntry.signatureStorageKey),
    signatureMimeType: clampString(approvalEntry.signatureMimeType || 'image/png', 50),
    signatureSizeBytes: safeNumber(approvalEntry.signatureSizeBytes, 0),
    reviewVersionHash: clampString(approvalEntry.reviewVersionHash, 64),
    originalDocumentFingerprint: clampString(approvalEntry.originalDocumentFingerprint, 64),
    approvalStatus: approvalEntry.approvalStatus || 'approved',
    signedAt: approvalEntry.signedAt || new Date(),
    relatedAuditActivityId: approvalEntry.relatedAuditActivityId
  };

  const [result] = await (transactionDatabase || database).query(
    `INSERT INTO medical_record_signatures (
      medical_record_id, admin_id, signature_storage_key, signature_mime_type,
      signature_size_bytes, review_version_hash, original_document_fingerprint,
      approval_status, signed_at, related_audit_activity_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signatureEntry.medicalRecordId,
      signatureEntry.adminId,
      signatureEntry.signatureStorageKey,
      signatureEntry.signatureMimeType,
      signatureEntry.signatureSizeBytes,
      signatureEntry.reviewVersionHash,
      signatureEntry.originalDocumentFingerprint,
      signatureEntry.approvalStatus,
      signatureEntry.signedAt,
      signatureEntry.relatedAuditActivityId
    ]
  );

  if (!result || !result.insertId) {
    throw new Error('Signature approval record insertion failed.');
  }

  return result.insertId;
}

async function publishMedicalRecord({
  recordId,
  adminUser,
  reviewPayload,
  originalDocument,
  signatureData,
  metadata,
  recordSnapshot = {},
  medicationEntries = null,
  expectedVersion = null,
  enforceRecordVersion = false
}) {
  if (!database) {
    throw new Error('Database unavailable for publication.');
  }

  if (!recordId) {
    throw new Error('A medical record id is required for publication.');
  }

  if (!adminUser || !adminUser.id) {
    throw new Error('An authenticated admin is required for publication.');
  }

  const requireSignature = Boolean(signatureData && signatureData.storageKey);
  const signatureStorageKey = requireSignature ? String(signatureData.storageKey) : null;

  const reviewVersionHash = computeReviewVersionHash(
    medicationEntries === null ? reviewPayload || {} : { ...reviewPayload, medicationEntries }
  );
  const originalDocumentFingerprint = computeOriginalDocumentFingerprint(originalDocument || Buffer.alloc(0));

  const title = clampString(recordSnapshot.recordTitle || metadata?.recordTitle || null, 200);
  const petName = clampString(recordSnapshot.petName || null, 80);

  if (typeof connection.createPetShopTransactionConnection !== 'function') {
    throw new Error('A dedicated MySQL connection is required for publication.');
  }
  const transactionDatabase = connection.createPetShopTransactionConnection().promise();
  let started = false;
  let committing = false;
  try {
    await transactionDatabase.connect();
    await transactionDatabase.beginTransaction();
    started = true;

    const [recordRows] = await transactionDatabase.query(
      `SELECT id, pet_id, title, category_code, source_name, record_date, storage_key, document_mime_type,
              description, extracted_document_text, extraction_status
       FROM medical_records
       WHERE id = ? AND publication_status = 'draft'
       FOR UPDATE`,
      [recordId]
    );

    if (!recordRows.length) {
      throw new Error('This medical record is no longer a draft and cannot be published.');
    }

    const publishedRecord = recordRows[0];
    if ((publishedRecord.category_code === 'medication_history' ||
         recordSnapshot.categoryCode === 'medication_history') &&
        (!requireSignature || !Array.isArray(medicationEntries) || !expectedVersion)) {
      throw new Error('Medication publication requires reviewed entries and a signature.');
    }
    if ((recordSnapshot.petId != null && String(recordSnapshot.petId) !== String(publishedRecord.pet_id)) ||
        (recordSnapshot.storageKey != null && recordSnapshot.storageKey !== publishedRecord.storage_key) ||
        (recordSnapshot.documentMimeType != null && recordSnapshot.documentMimeType !== publishedRecord.document_mime_type)) {
      throw new Error('The original document or pet changed during review.');
    }
    if (enforceRecordVersion && medicationEntries === null &&
        medicalReviewVersion(publishedRecord, []) !== expectedVersion) {
      const error = new Error('The record changed since it was reviewed.');
      error.code = 'STALE_MEDICATION_REVIEW';
      throw error;
    }
    if (medicationEntries !== null) {
      await assertCurrentMedicationReview(transactionDatabase, publishedRecord, expectedVersion);
      await require('./medicationRefillModel').replaceDraftMedicationEntries(
        transactionDatabase, recordId, publishedRecord.pet_id, adminUser.id, medicationEntries
      );
    }
    const [updateResult] = await transactionDatabase.query(
      `UPDATE medical_records
       SET category_code = ?, title = ?, source_name = ?, record_date = ?,
           description = ?, extracted_document_text = ?, extraction_status = ?,
           reviewed_by_admin_id = ?, reviewed_at = CURRENT_TIMESTAMP,
           publication_status = 'published', published_at = CURRENT_TIMESTAMP
       WHERE id = ? AND publication_status = 'draft'`,
      [
        recordSnapshot.categoryCode || publishedRecord.category_code,
        title || publishedRecord.title,
        recordSnapshot.sourceName || publishedRecord.source_name,
        recordSnapshot.recordDate === undefined ? publishedRecord.record_date : recordSnapshot.recordDate,
        recordSnapshot.description === undefined ? publishedRecord.description : recordSnapshot.description,
        recordSnapshot.extractedText === undefined ? publishedRecord.extracted_document_text : recordSnapshot.extractedText,
        recordSnapshot.extractionStatus || publishedRecord.extraction_status,
        adminUser.id,
        recordId
      ]
    );

    if (!updateResult || updateResult.affectedRows === 0) {
      throw new Error('The medical record publication update failed.');
    }

    const actionEntry = {
      adminId: adminUser.id,
      adminUsername: clampString(adminUser.username || null, 50),
      adminName: clampString(adminUser.name || adminUser.username || null, 100),
      actionType: 'MEDICAL_RECORD_PUBLISHED',
      targetEntityType: 'medical_record',
      targetEntityId: recordId,
      petId: recordSnapshot.petId || publishedRecord.pet_id || null,
      petName,
      medicalRecordId: recordId,
      medicalRecordTitle: title,
      actionResult: 'success',
      metadata: {
        summary: metadata?.summary || 'Medical record published',
        categoryCode: metadata?.categoryCode || recordSnapshot.categoryCode || null,
        recordTitle: title || null
      }
    };

    const auditId = await logAdminAction(actionEntry, transactionDatabase);
    if (!auditId) {
      throw new Error('Admin activity log insertion failed while publishing.');
    }

    let signatureId = null;
    if (requireSignature) {
      if (!signatureStorageKey) {
        throw new Error('A handwritten signature is required for publication.');
      }

      signatureId = await recordSignedApproval({
        medicalRecordId: recordId,
        adminId: adminUser.id,
        signatureStorageKey: signatureStorageKey,
        signatureMimeType: signatureData.mimeType,
        signatureSizeBytes: signatureData.sizeBytes,
        reviewVersionHash,
        originalDocumentFingerprint,
        approvalStatus: 'approved',
        relatedAuditActivityId: auditId
      }, transactionDatabase);

      if (!signatureId) {
        throw new Error('Signature approval insertion failed while publishing.');
      }
    }

    committing = true;
    await transactionDatabase.commit();
    started = false;
    return { auditId, signatureId };
  } catch (error) {
    if (committing) error.commitOutcomeUnknown = true;
    if (started && !committing) {
      try {
        await transactionDatabase.rollback();
      } catch (rollbackError) {
        error.commitOutcomeUnknown = true;
        console.error('Publication rollback failed:', rollbackError.code || 'UNKNOWN');
      }
    }
    throw error;
  } finally {
    try {
      await transactionDatabase.end();
    } catch (error) {
      console.error('Publication connection close failed:', error.code || 'UNKNOWN');
    }
  }
}

async function getAdminActivityLogs(filters = {}, pagination = {}) {
  if (!database) return { items: [], total: 0, migrationReady: false };

  const logsReady = await tableExists('admin_activity_logs');
  if (!logsReady) return { items: [], total: 0, migrationReady: false };

  const limit = safeNumber(pagination.limit, 20);
  const offset = safeNumber(pagination.offset, 0);
  const params = [];
  const clauses = [];

  if (filters.adminUsername) {
    const adminUsername = String(filters.adminUsername).trim();
    if (adminUsername) {
      clauses.push('al.admin_username LIKE ?');
      params.push(`%${adminUsername}%`);
    }
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const countSql = `SELECT COUNT(*) AS total
    FROM admin_activity_logs al
    ${whereClause}`;

  const [countRows] = await database.query(countSql, params);
  const total = Number(countRows[0]?.total || 0);

  const listSql = `SELECT al.id, al.admin_id, al.action_type, al.target_entity_type,
      al.target_entity_id, al.pet_id, p.name AS pet_name,
      al.medical_record_id, al.action_result, al.metadata, al.admin_username,
      al.created_at
    FROM admin_activity_logs al
    LEFT JOIN pets p ON p.id = al.pet_id
    ${whereClause}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT ? OFFSET ?`;

  const [rows] = await database.query(listSql, [...params, limit, offset]);

  return {
    items: rows,
    total,
    limit,
    offset,
    migrationReady: true
  };
}

function computeReviewVersionHash(reviewPayload) {
  const normalized = JSON.stringify(reviewPayload || {});
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function computeOriginalDocumentFingerprint(documentBuffer) {
  return crypto.createHash('sha256').update(documentBuffer || Buffer.alloc(0)).digest('hex');
}

module.exports = {
  isFeatureReady,
  logAdminAction,
  recordSignedApproval,
  publishMedicalRecord,
  getAdminActivityLogs,
  computeReviewVersionHash,
  computeOriginalDocumentFingerprint,
  tableExists
};
