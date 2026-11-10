const medicalRecordModel = require('../models/medicalRecordModel');
const medicationRefillModel = require('../models/medicationRefillModel');
const { randomUUID } = require('crypto');
const { REASONS, DEMO_UNITS, validateRefillDetails } = require('../helpers/refillRequestDetails');
const {
  detectDocumentMimeType
} = require('../helpers/medicalDocumentExtraction');
const { readOriginalDocument } = require('../helpers/privateMedicalStorage');

const UINT_MAX = 4294967295;
const MAX_MEDICAL_RECORD_ID = 18446744073709551615n;
const CATEGORY_ORDER = [
  'x_rays_imaging',
  'test_results',
  'medical_history',
  'immunisation_records',
  'medication_history'
];
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png'
]);

function parsePetId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(normalized)) return null;
  const petId = Number(normalized);
  return Number.isSafeInteger(petId) && petId > 0 && petId <= UINT_MAX
    ? petId
    : null;
}

function parseMedicalRecordId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(normalized)) return null;
  const recordId = BigInt(normalized);
  return recordId > 0n && recordId <= MAX_MEDICAL_RECORD_ID
    ? recordId.toString()
    : null;
}

function formatRecordDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

async function loadOwnerPet(petId, ownerId) {
  return medicalRecordModel.getOwnerPetById(petId, ownerId);
}

async function listPetMedicalRecords(req, res) {
  const petId = parsePetId(req.params.petId);
  if (!petId) return res.status(404).send('Pet health passport not found.');

  try {
    const [pet, categories] = await Promise.all([
      loadOwnerPet(petId, req.session.user.id),
      medicalRecordModel.getCategories()
    ]);
    if (!pet) return res.status(404).send('Pet health passport not found.');

    const records = await medicalRecordModel.getPublishedRecordsForOwnerPet(
      petId,
      req.session.user.id
    );
    const orderedCategories = categories.sort((left, right) => {
      const leftOrder = CATEGORY_ORDER.indexOf(left.category_code);
      const rightOrder = CATEGORY_ORDER.indexOf(right.category_code);
      return (leftOrder < 0 ? CATEGORY_ORDER.length : leftOrder) -
        (rightOrder < 0 ? CATEGORY_ORDER.length : rightOrder);
    });
    const requestedCategory = req.query.category;
    if (requestedCategory !== undefined && typeof requestedCategory !== 'string') {
      return res.status(404).send('Medical record category not found.');
    }
    const selectedCategory = requestedCategory !== undefined
      ? orderedCategories.find(category => category.category_code === requestedCategory)
      : orderedCategories.find(category =>
          records.some(record => record.category_code === category.category_code)
        ) || orderedCategories[0];
    if (!selectedCategory) return res.status(404).send('Medical record category not found.');

    const categoryCounts = new Map(orderedCategories.map(category => [
      category.category_code,
      0
    ]));
    records.forEach(record => {
      if (categoryCounts.has(record.category_code)) {
        categoryCounts.set(
          record.category_code,
          categoryCounts.get(record.category_code) + 1
        );
      }
    });

    return res.render('userMedicalRecords', {
      session: req.session,
      pet,
      categories: orderedCategories.map(category => ({
        ...category,
        recordCount: categoryCounts.get(category.category_code)
      })),
      selectedCategory,
      records: records
        .filter(record => record.category_code === selectedCategory.category_code)
        .map(record => ({ ...record, displayRecordDate: formatRecordDate(record.record_date) }))
    });
  } catch (error) {
    if (error.code) {
      console.error('Owner medical passport query failed:', error.code);
    }
    return res.status(500).send('Unable to load this pet health passport right now.');
  }
}

function parseMedicationEntryId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(normalized)) return null;
  const entryId = BigInt(normalized);
  return entryId > 0n && entryId <= MAX_MEDICAL_RECORD_ID
    ? entryId.toString()
    : null;
}

async function newOwnerRefillRequest(req, res) {
  const petId = parsePetId(req.params.petId);
  const recordId = parseMedicalRecordId(req.params.recordId);
  const medicationEntryId = parseMedicationEntryId(req.params.medicationEntryId);
  if (!petId || !recordId || !medicationEntryId) return res.status(404).send('Medication not found.');

  try {
    const pet = await loadOwnerPet(petId, req.session.user.id);
    if (!pet) return res.status(404).send('Medication not found.');
    const medication = await medicationRefillModel.getMedicationEntryForOwnerPet(
      medicationEntryId,
      petId,
      req.session.user.id
    );
    if (!medication || String(medication.medical_record_id) !== recordId) {
      return res.status(404).send('Medication not found.');
    }
    return res.redirect(`/pets/${petId}/medical-records/${recordId}#medication-details`);
  } catch (error) {
    if (error.code === 'MEDICATION_REFILL_MIGRATION_REQUIRED') {
      return res.status(503).send('Medication refill requests are not available until the proposed database migration is approved and applied.');
    }
    console.error('Owner refill request form lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load the refill request form right now.');
  }
}

async function createOwnerRefillRequest(req, res) {
  const petId = parsePetId(req.params.petId);
  const recordId = parseMedicalRecordId(req.params.recordId);
  const medicationEntryId = parseMedicationEntryId(req.params.medicationEntryId);
  if (!petId || !recordId || !medicationEntryId) return res.status(404).send('Medication not found.');

  const detailUrl = `/pets/${petId}/medical-records/${recordId}#medication-details`;
  try {
    const medication = await medicationRefillModel.getMedicationEntryForOwnerPet(
      medicationEntryId, petId, req.session.user.id
    );
    if (!medication || String(medication.medical_record_id) !== recordId) {
      return res.status(404).send('Medication not found.');
    }
    const body = req.body || {};
    if (typeof body.request_key !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_key) ||
        !validateRefillDetails(body.refill_reason, body.requested_quantity,
          body.requested_quantity_unit, medication.refill_quantity_unit)) {
      req.flash('error', 'Choose a valid reason and quantity unit and enter a positive whole-number quantity.');
      return res.redirect(detailUrl);
    }
    const result = await medicationRefillModel.createOwnerRefillRequest({
      requestKey: body.request_key,
      ownerId: req.session.user.id,
      petId,
      recordId,
      medicationEntryId,
      reason: body.refill_reason,
      quantity: Number(body.requested_quantity),
      unit: body.requested_quantity_unit
    });
    const submitted = result.duplicateSubmission ? 'again' : 'yes';
    return res.redirect(`/pets/${petId}/medical-records/refill-requests?submitted=${submitted}#request-${result.id}`);
  } catch (error) {
    if (error.code === 'ACTIVE_REQUEST_EXISTS') {
      return res.redirect(`/pets/${petId}/medical-records/refill-requests?submitted=existing`);
    }
    if (error.code === 'MEDICATION_NOT_FOUND') return res.status(404).send('Medication not found.');
    if (error.code === 'INVALID_REQUEST_KEY') return res.status(400).send('Invalid refill request form.');
    if (error.code === 'MEDICATION_REFILL_MIGRATION_REQUIRED') {
      return res.status(503).send('Medication refill requests are currently unavailable.');
    }
    console.error('Owner refill request submission failed:', error.code || 'UNKNOWN');
    if (error.commitOutcomeUnknown) {
      return res.status(500).send('The request outcome is uncertain. Check your refill requests before retrying.');
    }
    return res.status(500).send('Unable to submit the refill request right now.');
  }
}

function formatSgdCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const cents = BigInt(value);
  return `SGD ${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
}

async function listOwnerRefillRequests(req, res) {
  const petId = parsePetId(req.params.petId);
  if (!petId) return res.status(404).send('Pet health passport not found.');

  try {
    const pet = await loadOwnerPet(petId, req.session.user.id);
    if (!pet) return res.status(404).send('Pet health passport not found.');
    if (!(await medicationRefillModel.isFeatureReady())) {
      return res.render('userMedicationRefillRequests', {
        session: req.session,
        pet,
        requests: [],
        featureReady: false,
        submitted: null,
        formatSgdCents
      });
    }

    const requests = await medicationRefillModel.getOwnerRefillRequests(
      petId,
      req.session.user.id
    );
    return res.render('userMedicationRefillRequests', {
      session: req.session,
      pet,
      requests: requests.map(request => ({
        ...request,
        displayPrice: formatSgdCents(request.demo_price_cents)
      })),
      featureReady: true,
      submitted: typeof req.query.submitted === 'string' ? req.query.submitted : null,
      formatSgdCents
    });
  } catch (error) {
    console.error('Owner refill requests lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load refill requests right now.');
  }
}

async function viewPetMedicalRecord(req, res) {
  const petId = parsePetId(req.params.petId);
  const recordId = parseMedicalRecordId(req.params.recordId);
  if (!petId || !recordId) return res.status(404).send('Medical record not found.');

  try {
    const pet = await loadOwnerPet(petId, req.session.user.id);
    if (!pet) return res.status(404).send('Medical record not found.');

    const record = await medicalRecordModel.getPublishedRecordForOwnerPet(
      petId,
      recordId,
      req.session.user.id
    );
    if (!record) return res.status(404).send('Medical record not found.');

    const refillFeatureReady = record.category_code === 'medication_history'
      ? await medicationRefillModel.isFeatureReady() : false;
    const medicationEntries = refillFeatureReady
      ? (await medicationRefillModel.getPublishedMedicationEntriesForOwnerPet(
        petId, req.session.user.id
      )).filter(entry => String(entry.medical_record_id) === recordId)
      : [];
    return res.render('userMedicalRecordDetail', {
      session: req.session,
      pet,
      record: { ...record, displayRecordDate: formatRecordDate(record.record_date) },
      refillFeatureReady,
      csrfToken: req.session.csrfToken,
      refillError: typeof req.flash === 'function' ? req.flash('error')[0] : null,
      refillReasons: REASONS,
      demoUnits: DEMO_UNITS,
      medicationEntries: medicationEntries.map(entry => ({
        ...entry,
        requestKey: randomUUID(),
        displayStartDate: formatRecordDate(entry.start_date),
        displayEndDate: formatRecordDate(entry.end_date)
      }))
    });
  } catch (error) {
    if (error.code) {
      console.error('Owner medical record lookup failed:', error.code);
    }
    return res.status(500).send('Unable to load this medical record right now.');
  }
}

async function sendOwnerOriginalDocument(req, res, disposition) {
  const petId = parsePetId(req.params.petId);
  const recordId = parseMedicalRecordId(req.params.recordId);
  if (!petId || !recordId) return res.status(404).send('Medical document not found.');

  try {
    const documentRecord = await medicalRecordModel.getPublishedRecordDocumentForOwnerPet(
      petId,
      recordId,
      req.session.user.id
    );
    if (!documentRecord) return res.status(404).send('Medical document not found.');
    if (!SUPPORTED_MIME_TYPES.has(documentRecord.document_mime_type)) {
      console.error('Unsupported stored medical document type for record:', recordId);
      return res.status(500).send('The original medical document failed its format check.');
    }

    const document = await readOriginalDocument(documentRecord.storage_key);
    if (detectDocumentMimeType(document) !== documentRecord.document_mime_type) {
      console.error('Private medical document format mismatch for record:', recordId);
      return res.status(500).send('The original medical document failed its format check.');
    }

    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.type(documentRecord.document_mime_type);
    if (disposition === 'download') {
      res.attachment(documentRecord.original_filename);
      res.type(documentRecord.document_mime_type);
    } else {
      res.set('Content-Disposition', 'inline');
    }
    return res.send(document);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('Private medical document is missing for record:', recordId);
      return res.status(404).send('The original medical document is unavailable.');
    }
    console.error('Owner medical document retrieval failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to retrieve the original medical document right now.');
  }
}

function previewOriginalDocument(req, res) {
  return sendOwnerOriginalDocument(req, res, 'inline');
}

function downloadOriginalDocument(req, res) {
  return sendOwnerOriginalDocument(req, res, 'download');
}

module.exports = {
  listPetMedicalRecords,
  viewPetMedicalRecord,
  newOwnerRefillRequest,
  createOwnerRefillRequest,
  listOwnerRefillRequests,
  previewOriginalDocument,
  downloadOriginalDocument
};
