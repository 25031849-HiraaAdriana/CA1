const crypto = require('crypto');

function medicalReviewVersion(record, entries) {
  const fields = [
    'id', 'pet_id', 'category_code', 'title', 'source_name', 'record_date',
    'description', 'extracted_document_text', 'extraction_status',
    'storage_key', 'document_mime_type'
  ];
  const medicationFields = ['id', 'medication_name', 'dosage', 'frequency', 'start_date', 'end_date'];
  const values = fields.map(field => record[field] ?? null);
  const medicationValues = entries.map(entry => medicationFields.map(field => entry[field] ?? null));
  return crypto.createHash('sha256').update(JSON.stringify([values, medicationValues])).digest('hex');
}

async function assertCurrentMedicationReview(database, record, expectedVersion) {
  const [entries] = await database.query(
    `SELECT id, medication_name, dosage, frequency, start_date, end_date
     FROM medication_entries WHERE medical_record_id = ? ORDER BY id`,
    [record.id]
  );
  if (!expectedVersion || medicalReviewVersion(record, entries) !== expectedVersion) {
    const error = new Error('The draft changed since it was opened.');
    error.code = 'STALE_MEDICATION_REVIEW';
    throw error;
  }
}

module.exports = { medicalReviewVersion, assertCurrentMedicationReview };
