const connection = require('../config/db');
const { medicalCategoryLabel } = require('../helpers/medicalCategoryLabel');

const database = connection.promise();

async function supportsPublicationWithoutExtraction() {
  const [columns] = await database.query(
    `SELECT COLUMN_TYPE AS column_type FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medical_records'
       AND COLUMN_NAME = 'extraction_status'`
  );
  const [checks] = await database.query(
    `SELECT cc.CHECK_CLAUSE AS check_clause, tc.ENFORCED AS enforced
     FROM information_schema.TABLE_CONSTRAINTS tc
     JOIN information_schema.CHECK_CONSTRAINTS cc
       ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
     WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'medical_records'
       AND tc.CONSTRAINT_NAME = 'chk_medical_records_publication'
       AND tc.CONSTRAINT_TYPE = 'CHECK'`
  );
  const expectedCheck =
    "(((publication_status='draft')and(published_atisnull))or" +
    "((publication_status='published')and(reviewed_by_admin_idisnotnull)and(reviewed_atisnotnull)and(published_atisnotnull)and" +
    "(((extraction_status='successful')and(extracted_document_textisnotnull)and(char_length(trim(extracted_document_text))>0))or" +
    "((extraction_status='image_only_reviewed')and(category_code='x_rays_imaging')and(document_mime_typein('image/jpeg','image/png'))and" +
    "((extracted_document_textisnull)or(char_length(trim(extracted_document_text))=0)))or" +
    "((extraction_status='not_extracted')and(extracted_document_textisnull)))))";
  const clause = checks[0] && checks[0].check_clause;
  const normalized = typeof clause === 'string'
    ? clause.replace(/\\'/g, "'").replace(/_utf8mb4/gi, '').replace(/[`\s]/g, '').toLowerCase()
    : '';
  return Boolean(columns[0] && columns[0].column_type.includes("'not_extracted'") &&
    checks[0] && checks[0].enforced === 'YES' && normalized === expectedCheck);
}

async function getCategories() {
  const [categories] = await database.query(
    `SELECT category_code, category_name
     FROM medical_record_categories
     WHERE category_code <> 'lab_reports'
     ORDER BY category_name`
  );
  return categories.map(category => ({
    ...category,
    category_name: medicalCategoryLabel(category.category_code, category.category_name)
  }));
}

async function searchRegisteredPets(searchTerm) {
  const trimmedSearch = typeof searchTerm === 'string' ? searchTerm.trim() : '';
  const searchPattern = `%${trimmedSearch}%`;
  const searchCondition = trimmedSearch
    ? 'WHERE p.name LIKE ? OR p.microchip_id LIKE ? OR p.avs_licence_number LIKE ?'
    : '';
  const parameters = trimmedSearch
    ? [searchPattern, searchPattern, searchPattern]
    : [];
  const [pets] = await database.query(
    `SELECT p.id, p.name, p.species, p.breed, p.avs_licence_number,
            p.microchip_id, u.name AS owner_name
     FROM pets p
     INNER JOIN users u ON u.id = p.owner_id
     ${searchCondition}
     ORDER BY p.name, p.id
     LIMIT 100`,
    parameters
  );
  return pets;
}

async function getPetById(petId) {
  const [pets] = await database.query(
    `SELECT id, name, species, breed, avs_licence_number, microchip_id
     FROM pets
     WHERE id = ?
     LIMIT 1`,
    [petId]
  );
  return pets[0] || null;
}

async function getOwnerPetById(petId, ownerId) {
  const [pets] = await database.query(
    `SELECT id, owner_id, name, species, breed, age, avs_licence_number,
            microchip_id, image
     FROM pets
     WHERE id = ? AND owner_id = ? AND status = 'active'
     LIMIT 1`,
    [petId, ownerId]
  );
  return pets[0] || null;
}

async function getPublishedRecordsForOwnerPet(petId, ownerId) {
  const [records] = await database.query(
    `SELECT mr.id, mr.pet_id, mr.category_code, category.category_name,
            mr.title, mr.source_name, mr.record_date, mr.description
     FROM medical_records mr
     INNER JOIN pets p ON p.id = mr.pet_id
     INNER JOIN medical_record_categories category
       ON category.category_code = mr.category_code
     WHERE mr.pet_id = ? AND p.owner_id = ? AND p.status = 'active'
       AND mr.publication_status = 'published'
       AND mr.category_code <> 'lab_reports'
     ORDER BY category.category_name, mr.record_date DESC, mr.id DESC`,
    [petId, ownerId]
  );
  return records.map(record => ({
    ...record,
    category_name: medicalCategoryLabel(record.category_code, record.category_name)
  }));
}

async function getPublishedRecordForOwnerPet(petId, recordId, ownerId) {
  const [records] = await database.query(
    `SELECT mr.id, mr.pet_id, p.name AS pet_name, mr.category_code,
            category.category_name, mr.title, mr.source_name, mr.record_date,
            mr.description, mr.extraction_status,
            mr.original_filename, mr.storage_key, mr.document_mime_type
     FROM medical_records mr
     INNER JOIN pets p ON p.id = mr.pet_id
     INNER JOIN medical_record_categories category
       ON category.category_code = mr.category_code
     WHERE mr.pet_id = ? AND mr.id = ? AND p.owner_id = ? AND p.status = 'active'
       AND mr.publication_status = 'published'
       AND mr.category_code <> 'lab_reports'
     LIMIT 1`,
    [petId, recordId, ownerId]
  );
  return records[0] ? {
    ...records[0],
    category_name: medicalCategoryLabel(records[0].category_code, records[0].category_name)
  } : null;
}

async function getPublishedRecordDocumentForOwnerPet(petId, recordId, ownerId) {
  const [records] = await database.query(
    `SELECT mr.id, mr.original_filename, mr.storage_key, mr.document_mime_type
     FROM medical_records mr
     INNER JOIN pets p ON p.id = mr.pet_id
     WHERE mr.pet_id = ? AND mr.id = ? AND p.owner_id = ? AND p.status = 'active'
       AND mr.publication_status = 'published'
       AND mr.category_code <> 'lab_reports'
     LIMIT 1`,
    [petId, recordId, ownerId]
  );
  return records[0] || null;
}

async function getDraftRecords() {
  const [records] = await database.query(
    `SELECT mr.id, mr.title, mr.source_name, mr.record_date, mr.extraction_status, mr.category_code,
            mr.uploaded_at, p.id AS pet_id, p.name AS pet_name,
            category.category_name
     FROM medical_records mr
     INNER JOIN pets p ON p.id = mr.pet_id
     INNER JOIN medical_record_categories category
       ON category.category_code = mr.category_code
     WHERE mr.publication_status = 'draft'
       AND mr.category_code <> 'lab_reports'
     ORDER BY mr.uploaded_at DESC, mr.id DESC`
  );
  return records.map(record => ({
    ...record,
    category_name: medicalCategoryLabel(record.category_code, record.category_name)
  }));
}

async function getDraftRecordById(recordId) {
  const [records] = await database.query(
    `SELECT mr.id, mr.pet_id, p.name AS pet_name, p.microchip_id,
            p.avs_licence_number, mr.category_code, category.category_name,
            mr.title, mr.source_name, mr.record_date, mr.description,
            mr.extracted_document_text, mr.extraction_status,
            mr.publication_status, mr.original_filename, mr.storage_key,
            mr.document_mime_type, mr.file_size_bytes, mr.uploaded_by_admin_id,
            uploader.name AS uploaded_by_admin_name, mr.uploaded_at
     FROM medical_records mr
     INNER JOIN pets p ON p.id = mr.pet_id
     INNER JOIN medical_record_categories category
       ON category.category_code = mr.category_code
     INNER JOIN users uploader ON uploader.id = mr.uploaded_by_admin_id
     WHERE mr.id = ? AND mr.publication_status = 'draft'
       AND mr.category_code <> 'lab_reports'
     LIMIT 1`,
    [recordId]
  );
  return records[0] || null;
}

async function getRecordDocumentById(recordId) {
  const [records] = await database.query(
    `SELECT id, original_filename, storage_key, document_mime_type
     FROM medical_records
     WHERE id = ?
       AND category_code <> 'lab_reports'
     LIMIT 1`,
    [recordId]
  );
  return records[0] || null;
}

async function updateDraftRecord(record) {
  const [result] = await database.query(
    `UPDATE medical_records
     SET category_code = ?, title = ?, source_name = ?, record_date = ?,
         description = ?, extracted_document_text = ?, extraction_status = ?,
         reviewed_by_admin_id = ?, reviewed_at = CURRENT_TIMESTAMP,
         publication_status = ?,
         published_at = IF(? = 'published', CURRENT_TIMESTAMP, NULL)
     WHERE id = ? AND publication_status = 'draft'`,
    [
      record.categoryCode,
      record.title,
      record.sourceName,
      record.recordDate,
      record.description,
      record.extractedText,
      record.extractionStatus,
      record.reviewedByAdminId,
      record.publicationStatus,
      record.publicationStatus,
      record.id
    ]
  );

  if (result.affectedRows > 0) return true;

  const [drafts] = await database.query(
    `SELECT id
     FROM medical_records
     WHERE id = ? AND publication_status = 'draft'
     LIMIT 1`,
    [record.id]
  );
  return drafts.length > 0;
}

async function createDraftRecord(record) {
  const [result] = await database.query(
    `INSERT INTO medical_records (
       pet_id, category_code, title, source_name, record_date, description,
       extracted_document_text, extraction_status, publication_status,
       original_filename, storage_key, document_mime_type, file_size_bytes,
       uploaded_by_admin_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    [
      record.petId,
      record.categoryCode,
      record.title,
      record.sourceName,
      record.recordDate,
      record.description,
      record.extractedText,
      record.extractionStatus,
      record.originalFilename,
      record.storageKey,
      record.documentMimeType,
      record.fileSizeBytes,
      record.uploadedByAdminId
    ]
  );
  return result.insertId;
}

module.exports = {
  supportsPublicationWithoutExtraction,
  getCategories,
  searchRegisteredPets,
  getPetById,
  getOwnerPetById,
  getPublishedRecordsForOwnerPet,
  getPublishedRecordForOwnerPet,
  getPublishedRecordDocumentForOwnerPet,
  getDraftRecords,
  getDraftRecordById,
  getRecordDocumentById,
  updateDraftRecord,
  createDraftRecord
};
