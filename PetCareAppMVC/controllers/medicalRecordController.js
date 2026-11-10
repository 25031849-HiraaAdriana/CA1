const crypto = require('crypto');
const path = require('path');
const medicalRecordModel = require('../models/medicalRecordModel');
const medicationRefillModel = require('../models/medicationRefillModel');
const adminActivityModel = require('../models/adminActivityModel');
const { medicalReviewVersion } = require('../helpers/medicalReviewVersion');
const {
  InvalidMedicalDocumentError,
  detectDocumentMimeType,
  validateMedicalDocument,
  hasMeaningfulText
} = require('../helpers/medicalDocumentExtraction');
const {
  storeOriginalDocument,
  removeOriginalDocument,
  readOriginalDocument
} = require('../helpers/privateMedicalStorage');
const {
  storeSignature,
  removeSignature,
  parseDataUrl
} = require('../helpers/privateSignatureStorage');
const { MAX_MEDICAL_DOCUMENT_SIZE } = require('../config/medicalRecordUpload');

const UINT_MAX = 4294967295;
const MAX_MEDICAL_RECORD_ID = 18446744073709551615n;

function getString(value) {
  return typeof value === 'string' ? value : '';
}

function parseUnsignedId(value) {
  let id;
  if (typeof value === 'number') {
    id = value;
  } else {
    const normalized = getString(value).trim();
    if (!/^\d+$/.test(normalized)) return null;
    id = Number(normalized);
  }

  return Number.isSafeInteger(id) && id > 0 && id <= UINT_MAX ? id : null;
}

function parseMedicalRecordId(value) {
  const normalized = getString(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  const recordId = BigInt(normalized);
  return recordId > 0n && recordId <= MAX_MEDICAL_RECORD_ID
    ? recordId.toString()
    : null;
}

function normalizeOriginalFilename(filename) {
  const basename = path.win32.basename(getString(filename).replace(/\0/g, ''));
  const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return Array.from(cleaned || 'uploaded-document').slice(0, 255).join('');
}

function parseRecordDate(value) {
  const date = getString(value).trim();
  if (!date) return { valid: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { valid: false, value: null };

  const [year, month, day] = date.split('-').map(Number);
  if (year < 1000) return { valid: false, value: null };
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  const isValid = parsedDate.getUTCFullYear() === year &&
    parsedDate.getUTCMonth() === month - 1 &&
    parsedDate.getUTCDate() === day;
  return { valid: isValid, value: isValid ? date : null };
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

async function recordAdminAuditAction(req, actionType, metadata = {}, options = {}) {
  const adminId = req && req.session && req.session.user ? req.session.user.id : null;
  if (!adminId || !actionType) return null;

  const auditId = await adminActivityModel.logAdminAction({
    adminId,
    adminUsername: req.session.user.username || null,
    adminName: req.session.user.name || req.session.user.username || null,
    actionType,
    targetEntityType: metadata.targetEntityType || 'medical_record',
    targetEntityId: metadata.targetEntityId || null,
    petId: metadata.petId || null,
    petName: metadata.petName || null,
    medicalRecordId: metadata.medicalRecordId || null,
    medicalRecordTitle: metadata.recordTitle || null,
    actionResult: metadata.actionResult || 'success',
    metadata: {
      summary: metadata.summary || actionType,
      categoryCode: metadata.categoryCode || null,
      recordTitle: metadata.recordTitle || null
    }
  });

  if (auditId === null || auditId === undefined) {
    if (options.throwOnFailure) {
      throw new Error('Admin audit log insertion failed.');
    }
    return null;
  }

  return auditId;
}

function parseSignatureDataUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.startsWith('data:image/') ? trimmed : '';
}

function buildReviewVersionHash(record, formData) {
  return crypto.createHash('sha256').update(JSON.stringify({
    medicalRecordId: record.id,
    categoryCode: formData.categoryCode,
    title: formData.title,
    sourceName: formData.sourceName,
    recordDate: formData.recordDate,
    description: formData.description,
    extractedText: formData.extractedText,
    imageOnlyReviewed: formData.imageOnlyReviewed,
    medicationEntries: formData.medications,
    petId: record.pet_id,
    source: 'pethub-signature-review'
  })).digest('hex');
}

function getRepeatedStringValues(body, name) {
  const value = body[`${name}[]`] ?? body[name];
  if (Array.isArray(value)) return value.map(getString);
  return typeof value === 'string' ? [value] : [];
}

function getMedicationFormEntries(body, fallback = []) {
  const names = getRepeatedStringValues(body, 'medication_name');
  const dosages = getRepeatedStringValues(body, 'medication_dosage');
  const frequencies = getRepeatedStringValues(body, 'medication_frequency');
  const startDates = getRepeatedStringValues(body, 'medication_start_date');
  const endDates = getRepeatedStringValues(body, 'medication_end_date');

  if (![names, dosages, frequencies, startDates, endDates].some(values => values.length)) {
    return fallback.map(entry => ({
      medicationName: entry.medication_name || entry.medicationName || '',
      dosage: entry.dosage || '',
      frequency: entry.frequency || '',
      startDate: formatRecordDate(entry.start_date || entry.startDate),
      endDate: formatRecordDate(entry.end_date || entry.endDate)
    }));
  }

  return names.map((medicationName, index) => ({
    medicationName: medicationName.trim(),
    dosage: (dosages[index] || '').trim(),
    frequency: (frequencies[index] || '').trim(),
    startDate: (startDates[index] || '').trim(),
    endDate: (endDates[index] || '').trim()
  }));
}

function validateMedicationEntries(entries) {
  const validated = [];
  if (entries.length > 10) {
    return { error: 'A medical record can contain at most 10 structured medication entries.' };
  }
  for (const entry of entries) {
    if (!Object.values(entry).some(value => value !== '')) continue;
    const startDate = parseRecordDate(entry.startDate);
    const endDate = parseRecordDate(entry.endDate);
    if (!entry.medicationName || entry.medicationName.length > 200 ||
        entry.dosage.length > 120 || entry.frequency.length > 120 ||
        !startDate.valid || !endDate.valid ||
        (startDate.value && endDate.value && endDate.value < startDate.value)) {
      return { error: 'Enter a medication name of up to 200 characters, dosage and frequency up to 120 characters, and valid dates in chronological order.' };
    }
    validated.push({
      medicationName: entry.medicationName,
      dosage: entry.dosage || null,
      frequency: entry.frequency || null,
      startDate: startDate.value,
      endDate: endDate.value
    });
  }
  return { entries: validated };
}

function getReviewFormData(body, record) {
  const medicationEntries = getMedicationFormEntries(
    body,
    record.medicationEntries || []
  );
  return {
    categoryCode: getString(body.category_code ?? record.category_code),
    title: getString(body.title ?? record.title),
    sourceName: getString(body.source_name ?? record.source_name),
    recordDate: getString(body.record_date ?? formatRecordDate(record.record_date)),
    description: getString(body.description ?? record.description),
    extractedText: getString(body.extracted_document_text ?? record.extracted_document_text),
    imageOnlyReviewed: body.image_only_reviewed === 'yes' ||
      (!body.action && record.extraction_status === 'image_only_reviewed'),
    confirmPublish: body.confirm_publish === 'yes',
    medications: medicationEntries
  };
}

function getFormData(body) {
  return {
    petId: getString(body.pet_id),
    categoryCode: getString(body.category_code),
    title: getString(body.title),
    sourceName: getString(body.source_name),
    recordDate: getString(body.record_date),
    description: getString(body.description)
  };
}

async function renderNewRecordForm(req, res, options = {}) {
  if (req.newPublication) {
    return renderManagement(req, res, options);
  }
  const formData = options.formData || getFormData(req.body || {});
  const selectedPetId = parseUnsignedId(options.petId ?? formData.petId ?? req.query.petId);

  try {
    const categories = await medicalRecordModel.getCategories();
    const selectedPet = selectedPetId
      ? await medicalRecordModel.getPetById(selectedPetId)
      : null;

    return res.status(options.statusCode || 200).render('adminMedicalRecordNew', {
      session: req.session,
      categories,
      selectedPet,
      formData,
      errorMessage: options.errorMessage || null,
      csrfToken: req.session.csrfToken,
      maxFileSizeMb: MAX_MEDICAL_DOCUMENT_SIZE / (1024 * 1024)
    });
  } catch (error) {
    console.error('Medical record form lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load the medical record form right now.');
  }
}

async function renderManagement(req, res, options = {}) {
  const searchTerm = getString(req.query.q).trim().slice(0, 100);
  try {
    const [pets, categories] = await Promise.all([
      medicalRecordModel.searchRegisteredPets(searchTerm),
      medicalRecordModel.getCategories()
    ]);
    const selectedPetId = parseUnsignedId((req.body || {}).pet_id || req.query.petId);
    if (selectedPetId && !pets.some(pet => Number(pet.id) === selectedPetId)) {
      const selectedPet = await medicalRecordModel.getPetById(selectedPetId);
      if (selectedPet) pets.unshift(selectedPet);
    }

    return res.status(options.statusCode || 200).render('adminMedicalRecords', {
      session: req.session,
      searchTerm,
      pets,
      categories,
      formData: options.formData || getFormData(req.body || {}),
      selectedPetId,
      reviewData: getReviewFormData(req.body || {}, {}),
      csrfToken: req.session.csrfToken,
      successMessage: req.flash('success')[0] || null,
      errorMessage: options.errorMessage || req.flash('error')[0] || null
    });
  } catch (error) {
    console.error('Medical records management lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load medical records management right now.');
  }
}

async function listManagement(req, res) {
  return renderManagement(req, res);
}

async function reviewDraft(req, res) {
  const recordId = parseMedicalRecordId(req.params.id);
  if (!recordId) return res.status(404).send('Draft medical record not found.');

  try {
    const [record, categories] = await Promise.all([
      medicalRecordModel.getDraftRecordById(recordId),
      medicalRecordModel.getCategories()
    ]);
    if (!record) return res.status(404).send('Draft medical record not found.');

    let medicationEntries = [];
    let medicationFeatureReady = false;
    if (record.category_code === 'medication_history') {
      medicationFeatureReady = await medicationRefillModel.isFeatureReady();
      if (medicationFeatureReady) {
        medicationEntries = await medicationRefillModel.getDraftMedicationEntries(recordId);
      }
    }
    record.reviewVersion = medicalReviewVersion(record, medicationEntries);

    return res.render('adminMedicalRecordReview', {
      session: req.session,
      csrfToken: req.session.csrfToken,
      record,
      categories,
      formData: getReviewFormData({}, { ...record, medicationEntries }),
      medicationFeatureReady,
      successMessage: req.flash('success')[0] || null,
      errorMessage: req.flash('error')[0] || null
    });
  } catch (error) {
    console.error('Medical record review lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load this medical record for review right now.');
  }
}

async function updateDraftReview(req, res) {
  const recordId = parseMedicalRecordId(req.params.id);
  if (!recordId) return res.status(404).send('Draft medical record not found.');

  let record;
  let categories;
  try {
    [record, categories] = await Promise.all([
      medicalRecordModel.getDraftRecordById(recordId),
      medicalRecordModel.getCategories()
    ]);
  } catch (error) {
    console.error('Medical record review lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send(req.newPublication
      ? `The record was saved privately but could not be loaded. Do not upload it again. Contact an administrator with record ID ${recordId}.`
      : 'Unable to load this medical record for review right now.');
  }

  if (!record) return res.status(404).send(req.newPublication
    ? `The saved record could not be found. Do not upload it again. Contact an administrator with record ID ${recordId}.`
    : 'Draft medical record not found.');
  record.onePageRecovery = req.newPublication === true;

  let savedMedicationEntries = [];
  let medicationFeatureReady = false;
  try {
    const medicationCategoryRequested =
      getString(req.body && req.body.category_code) === 'medication_history';
    if (record.category_code === 'medication_history' || medicationCategoryRequested) {
      medicationFeatureReady = await medicationRefillModel.isFeatureReady();
    }
    if (medicationFeatureReady && record.category_code === 'medication_history') {
      savedMedicationEntries = await medicationRefillModel.getDraftMedicationEntries(recordId);
    }
  } catch (error) {
    console.error('Structured medication review lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send(req.newPublication
      ? `The record was saved privately but medication details could not be loaded. Do not upload it again. Contact an administrator with record ID ${recordId}.`
      : 'Unable to load structured medication details right now.');
  }
  const formData = getReviewFormData(req.body || {}, {
    ...record,
    medicationEntries: savedMedicationEntries
  });
  record.reviewVersion = getString(req.body && req.body.review_version);
  const action = getString(req.body && req.body.action);
  const recordDate = parseRecordDate(formData.recordDate);
  const withoutExtraction = req.newPublication || record.extraction_status === 'not_extracted';
  const imageOnlyEligible = formData.categoryCode === 'x_rays_imaging' &&
    (record.document_mime_type === 'image/jpeg' || record.document_mime_type === 'image/png');
  const text = withoutExtraction ? '' : formData.extractedText.replace(/\0/g, '').replace(/\r\n/g, '\n');
  const hasText = text.trim().length > 0;
  const meaningfulText = hasMeaningfulText(text);
  let errorMessage = null;
  let medicationEntries = [];
  let medicationValidationError = null;
  if (formData.categoryCode === 'medication_history') {
    if (!medicationFeatureReady) {
      medicationValidationError = 'Structured Medication History is unavailable until migrations/006_medication_refill_demo.sql is approved and applied.';
    } else {
      const validation = validateMedicationEntries(formData.medications);
      medicationValidationError = validation.error || null;
      medicationEntries = validation.entries || [];
    }
  }
  formData.medications = formData.categoryCode === 'medication_history'
    ? formData.medications
    : [];

  if (medicationValidationError) {
    errorMessage = medicationValidationError;
  } else if (action !== 'save_draft' && action !== 'publish') {
    errorMessage = 'Choose Save Draft or Publish to continue.';
  } else if (!formData.title.trim() || formData.title.trim().length > 200 ||
      !formData.sourceName.trim() || formData.sourceName.trim().length > 200) {
    errorMessage = 'Enter a record title and veterinary source, each up to 200 characters.';
  } else if (!categories.some(category => category.category_code === formData.categoryCode)) {
    errorMessage = 'Choose a medical record category from the available list.';
  } else if (!recordDate.valid) {
    errorMessage = 'Enter a valid record date.';
  } else if (Buffer.byteLength(formData.description, 'utf8') > 60000) {
    errorMessage = 'The description is too long. Keep it under 60 KB.';
  } else if (!withoutExtraction && formData.imageOnlyReviewed && (!imageOnlyEligible || hasText)) {
    errorMessage = 'Image-only review requires an image Radiology Results record with an empty extracted-text field.';
  } else if (action === 'publish' && !formData.confirmPublish) {
    errorMessage = 'Confirm that you reviewed the original document, extracted text and record details before publishing.';
  } else if (!withoutExtraction && action === 'publish' && !meaningfulText &&
      !(imageOnlyEligible && formData.imageOnlyReviewed)) {
    errorMessage = 'Add reviewed extracted text before publishing, or confirm that this is an image-only Radiology Results record.';
  }

  if (errorMessage) {
    if (req.newPublication) {
      return res.status(400).send(`The record was saved privately but could not be published: ${errorMessage} Do not upload it again. Contact an administrator with record ID ${recordId}.`);
    }
    return res.status(400).render('adminMedicalRecordReview', {
      session: req.session,
      csrfToken: req.session.csrfToken,
      record,
      categories,
      formData,
      medicationFeatureReady,
      successMessage: null,
      errorMessage
    });
  }

  const signatureFeatureReady = await adminActivityModel.isFeatureReady();
  const signatureDataUrl = parseSignatureDataUrl(req.body && req.body.signature_data_url);
  const medicationReview = record.category_code === 'medication_history' || formData.categoryCode === 'medication_history';
  const requireSignatureWorkflow = medicationReview || process.env.PETHUB_REQUIRE_SIGNATURES === '1' || process.env.PETHUB_ENABLE_SIGNATURES === '1';

  if (medicationReview && !medicationFeatureReady) {
    return res.status(503).send('Structured medication review is unavailable.');
  }
  if (medicationReview && !/^[a-f0-9]{64}$/.test(record.reviewVersion)) {
    return res.status(409).send('This review is out of date. Reload the draft before continuing.');
  }
  if (action === 'publish' && medicationReview && !signatureFeatureReady) {
    return res.status(503).send('Medication publication requires available signature and audit tables.');
  }

  if (action === 'publish' && (signatureFeatureReady || requireSignatureWorkflow) && !signatureDataUrl) {
    if (req.newPublication) {
      return res.status(400).send(`The record was saved privately but needs a signature. Do not upload it again. Contact an administrator with record ID ${recordId}.`);
    }
    return res.status(400).render('adminMedicalRecordReview', {
      session: req.session,
      csrfToken: req.session.csrfToken,
      record,
      categories,
      formData,
      medicationFeatureReady,
      successMessage: null,
      errorMessage: 'Draw your signature before publishing this medical record.'
    });
  }

  let originalDocument = null;
  if (action === 'publish') {
    try {
      originalDocument = await readOriginalDocument(record.storage_key);
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (req.newPublication) {
          return res.status(400).send(`The original document is unavailable. Do not upload it again. Contact an administrator with record ID ${recordId}.`);
        }
        return res.status(400).render('adminMedicalRecordReview', {
          session: req.session,
          csrfToken: req.session.csrfToken,
          record,
          categories,
          formData,
          medicationFeatureReady,
          successMessage: null,
          errorMessage: 'The original document is unavailable. The record cannot be published.'
        });
      }
      console.error('Original medical document verification failed:', error.code || 'UNKNOWN');
      return res.status(500).send(req.newPublication
        ? `The saved original could not be verified. Do not upload it again. Contact an administrator with record ID ${recordId}.`
        : 'Unable to verify the original medical document right now.');
    }

    if (detectDocumentMimeType(originalDocument) !== record.document_mime_type) {
      if (req.newPublication) {
        return res.status(400).send(`The saved original document failed validation. Do not upload it again. Contact an administrator with record ID ${recordId}.`);
      }
      return res.status(400).render('adminMedicalRecordReview', {
        session: req.session,
        csrfToken: req.session.csrfToken,
        record,
        categories,
        formData,
        medicationFeatureReady,
        successMessage: null,
        errorMessage: 'The original document content does not match its stored format. The record cannot be published.'
      });
    }

    try {
      await validateMedicalDocument(originalDocument, record.document_mime_type);
    } catch (error) {
      if (error instanceof InvalidMedicalDocumentError) {
        if (req.newPublication) {
          return res.status(400).send(`The saved original document failed validation. Do not upload it again. Contact an administrator with record ID ${recordId}.`);
        }
        return res.status(400).render('adminMedicalRecordReview', {
          session: req.session,
          csrfToken: req.session.csrfToken,
          record,
          categories,
          formData,
          medicationFeatureReady,
          successMessage: null,
          errorMessage: 'The original document is malformed or unreadable. The record cannot be published.'
        });
      }
      console.error('Original medical document could not be validated:', error.code || 'UNKNOWN');
      return res.status(500).send(req.newPublication
        ? `The saved original could not be validated. Do not upload it again. Contact an administrator with record ID ${recordId}.`
        : 'Unable to validate the original medical document right now.');
    }
  }

  const extractionStatus = withoutExtraction ? 'not_extracted' : hasText
    ? 'successful'
    : imageOnlyEligible && formData.imageOnlyReviewed
      ? 'image_only_reviewed'
      : 'failed_review_needed';

  if (medicationFeatureReady && action === 'save_draft') {
    try {
      const reviewSaved = await medicationRefillModel.saveDraftMedicationReview({
        id: recordId,
        adminId: req.session.user.id,
        adminUsername: req.session.user.username || null,
        adminName: req.session.user.name || req.session.user.username || null,
        petName: record.pet_name,
        expectedVersion: record.reviewVersion,
        categoryCode: formData.categoryCode,
        title: formData.title.trim(),
        sourceName: formData.sourceName.trim(),
        recordDate: recordDate.value,
        description: formData.description.trim() || null,
        extractedText: hasText ? text : null,
        extractionStatus,
        entries: formData.categoryCode === 'medication_history'
          ? medicationEntries
          : []
      });
      if (!reviewSaved) {
        return res.status(409).send('This Draft was changed or published by another Admin. Reload the Draft list before continuing.');
      }
    } catch (error) {
      if (error.code === 'STALE_MEDICATION_REVIEW' && !error.commitOutcomeUnknown) {
        return res.status(409).send(req.newPublication
          ? `The saved record changed during publication. Do not upload it again. Contact an administrator with record ID ${recordId}.`
          : 'This draft changed since it was opened. Reload it before continuing.');
      }
      console.error('Structured medication details could not be saved:', error.code || 'UNKNOWN');
      return res.status(500).render('adminMedicalRecordReview', {
        session: req.session,
        csrfToken: req.session.csrfToken,
        record,
        categories,
        formData,
        medicationFeatureReady,
        successMessage: null,
        errorMessage: error.commitOutcomeUnknown
          ? 'The draft save outcome is uncertain. Contact an administrator before retrying.'
          : 'Structured medication details could not be saved. No review or publication changes were made.'
      });
    }
  }

  if (action === 'save_draft') {
    if (!medicationFeatureReady) {
      try {
        const updated = await medicalRecordModel.updateDraftRecord({
          id: recordId,
          categoryCode: formData.categoryCode,
          title: formData.title.trim(),
          sourceName: formData.sourceName.trim(),
          recordDate: recordDate.value,
          description: formData.description.trim() || null,
          extractedText: hasText ? text : null,
          extractionStatus,
          reviewedByAdminId: req.session.user.id,
          publicationStatus: 'draft'
        });

        if (!updated) {
          return res.status(409).send('This Draft was changed or published by another Admin. Reload the Draft list before continuing.');
        }
      } catch (error) {
        console.error('Medical record review could not be saved:', error.code || 'UNKNOWN');
        return res.status(500).render('adminMedicalRecordReview', {
          session: req.session,
          csrfToken: req.session.csrfToken,
          record,
          categories,
          formData,
          medicationFeatureReady,
          successMessage: null,
          errorMessage: 'The review was not saved. Check that the record meets the publication requirements and try again.'
        });
      }
    }

    if (!medicationFeatureReady) await recordAdminAuditAction(req, 'MEDICAL_RECORD_DRAFT_UPDATED', {
      targetEntityType: 'medical_record',
      targetEntityId: recordId,
      petId: record.pet_id,
      petName: record.pet_name,
      storageKey: record.storage_key,
      documentMimeType: record.document_mime_type,
      medicalRecordId: recordId,
      actionResult: 'success',
      summary: 'Draft review saved',
      categoryCode: formData.categoryCode,
      recordTitle: formData.title.trim()
    });

    req.flash('success', 'Review corrections saved. The medical record remains a Draft.');
    return res.redirect(`/admin/medical-records/${encodeURIComponent(recordId)}/review`);
  }

  if (action === 'publish') {
    const publishedMetadata = {
      targetEntityType: 'medical_record',
      targetEntityId: recordId,
      petId: record.pet_id,
      petName: record.pet_name,
      medicalRecordId: recordId,
      actionResult: 'success',
      summary: 'Medical record signed and published',
      categoryCode: formData.categoryCode,
      recordTitle: formData.title.trim()
    };

    const reviewPayload = {
      recordId,
      categoryCode: formData.categoryCode,
      title: formData.title.trim(),
      sourceName: formData.sourceName.trim(),
      recordDate: recordDate.value,
      description: formData.description.trim() || null,
      extractedText: text,
      imageOnlyReviewed: formData.imageOnlyReviewed,
      petId: record.pet_id,
      source: 'pethub-signature-review',
      medicationEntries
    };

    const publicationRequiresSignature = signatureFeatureReady || requireSignatureWorkflow;
    let pendingSignatureKey = null;
    let signatureArtifacts = null;

    try {
      if (publicationRequiresSignature) {
        signatureArtifacts = await storeSignature(signatureDataUrl);
        pendingSignatureKey = signatureArtifacts.storageKey;

        await adminActivityModel.publishMedicalRecord({
          recordId,
          adminUser: req.session.user,
          reviewPayload,
          originalDocument,
          signatureData: signatureArtifacts,
          metadata: publishedMetadata,
          expectedVersion: record.reviewVersion,
          enforceRecordVersion: req.newPublication === true,
          medicationEntries: medicationFeatureReady
            ? (formData.categoryCode === 'medication_history' ? medicationEntries : [])
            : null,
          recordSnapshot: {
            petId: record.pet_id,
            petName: record.pet_name,
            recordTitle: formData.title.trim(),
            categoryCode: formData.categoryCode,
            sourceName: formData.sourceName.trim(),
            recordDate: recordDate.value,
            description: formData.description.trim() || null,
            extractedText: hasText ? text : null,
            extractionStatus,
            storageKey: record.storage_key,
            documentMimeType: record.document_mime_type
          }
        });
      } else {
        const updated = await medicalRecordModel.updateDraftRecord({
          id: recordId,
          categoryCode: formData.categoryCode,
          title: formData.title.trim(),
          sourceName: formData.sourceName.trim(),
          recordDate: recordDate.value,
          description: formData.description.trim() || null,
          extractedText: hasText ? text : null,
          extractionStatus,
          reviewedByAdminId: req.session.user.id,
          publicationStatus: 'published'
        });

        if (!updated) {
          throw new Error('The draft could not be published.');
        }

        if (signatureFeatureReady) {
          await recordAdminAuditAction(req, 'MEDICAL_RECORD_PUBLISHED', publishedMetadata, { throwOnFailure: true });
        }
      }
    } catch (error) {
      if (error.code === 'STALE_MEDICATION_REVIEW' && !error.commitOutcomeUnknown) {
        if (pendingSignatureKey) {
          try {
            await removeSignature(pendingSignatureKey);
          } catch (cleanupError) {
            console.error('Signature cleanup failed:', cleanupError.code || 'UNKNOWN');
          }
        }
        return res.status(409).send(req.newPublication
          ? `The saved record changed during publication. Do not upload it again. Contact an administrator with record ID ${recordId}.`
          : 'This draft changed since it was opened. Reload it before continuing.');
      }
      console.error('Medical record publication failed:', error.code || error.message || 'UNKNOWN');
      if (pendingSignatureKey && !error.commitOutcomeUnknown) {
        try {
          await removeSignature(pendingSignatureKey);
        } catch (cleanupError) {
          console.error('Signature cleanup failed:', cleanupError.code || 'UNKNOWN');
        }
      }
      if (req.newPublication) {
        return res.status(400).send(error.commitOutcomeUnknown
          ? `The publication outcome is uncertain; the signature file was retained. Do not upload it again. Contact an administrator with record ID ${recordId}.`
          : `The record was saved privately, but its signature or audit could not be saved securely; publication failed. Do not upload it again. Contact an administrator with record ID ${recordId}.`);
      }
      return res.status(400).render('adminMedicalRecordReview', {
        session: req.session,
        csrfToken: req.session.csrfToken,
        record,
        categories,
        formData,
        medicationFeatureReady,
        successMessage: null,
        errorMessage: error.commitOutcomeUnknown
          ? 'The publication outcome is uncertain. Contact an administrator before retrying; the signature file was retained for investigation.'
          : publicationRequiresSignature
          ? 'The handwritten signature or audit record could not be saved securely. The record was not published.'
          : 'The publication step could not be completed safely. The record was not published.'
      });
    }

    req.flash('success', 'Medical record reviewed and published for future owner-facing access.');
    return res.redirect('/admin/medical-records');
  }

  req.flash('success', 'Review corrections saved. The medical record remains a Draft.');
  return res.redirect(`/admin/medical-records/${encodeURIComponent(recordId)}/review`);
}

async function sendOriginalDocument(req, res, disposition) {
  const recordId = parseMedicalRecordId(req.params.id);
  if (!recordId) return res.status(404).send('Medical document not found.');

  try {
    const record = await medicalRecordModel.getRecordDocumentById(recordId);
    if (!record) return res.status(404).send('Medical document not found.');

    const document = await readOriginalDocument(record.storage_key);
    if (detectDocumentMimeType(document) !== record.document_mime_type) {
      console.error('Private medical document format mismatch for record:', recordId);
      return res.status(500).send('The original medical document failed its format check.');
    }

    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.type(record.document_mime_type);
    if (disposition === 'download') {
      res.attachment(record.original_filename);
      res.type(record.document_mime_type);
    } else {
      res.set('Content-Disposition', 'inline');
    }
    return res.send(document);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('Private medical document is missing for record:', recordId);
      return res.status(404).send('The original medical document is unavailable.');
    }
    console.error('Private medical document could not be read:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to retrieve the original medical document right now.');
  }
}

function previewOriginalDocument(req, res) {
  return sendOriginalDocument(req, res, 'inline');
}

function downloadOriginalDocument(req, res) {
  return sendOriginalDocument(req, res, 'download');
}

async function newRecordForm(req, res) {
  const petId = parseUnsignedId(req.query.petId);
  if (req.query.petId && !petId) {
    return renderNewRecordForm(req, res, {
      statusCode: 400,
      errorMessage: 'Select a valid registered pet before adding a medical record.'
    });
  }

  if (petId) {
    try {
      const pet = await medicalRecordModel.getPetById(petId);
      if (!pet) {
        return renderNewRecordForm(req, res, {
          petId: null,
          statusCode: 404,
          errorMessage: 'The selected registered pet could not be found.'
        });
      }
    } catch (error) {
      console.error('Medical record pet lookup failed:', error.code || 'UNKNOWN');
      return res.status(500).send('Unable to load the selected pet right now.');
    }
  }

  return renderNewRecordForm(req, res, { petId });
}

async function createDraft(req, res) {
  if (!req.newPublication) {
    try {
      if (!await medicalRecordModel.supportsPublicationWithoutExtraction()) {
        return renderNewRecordForm(req, res, {
          statusCode: 503,
          errorMessage: 'Saving new records without document extraction requires the reviewed database change.'
        });
      }
    } catch (error) {
      console.error('Medical record schema readiness check failed:', error.code || 'UNKNOWN');
      return res.status(500).send('Unable to verify medical record readiness right now.');
    }
  }
  const allowedFields = new Set(['_csrf', 'pet_id', 'category_code', 'title', 'source_name', 'record_date', 'description']);
  const medicationFields = new Set(['medication_name', 'medication_dosage', 'medication_frequency', 'medication_start_date', 'medication_end_date']);
  if (req.newPublication) {
    ['action', 'confirm_publish', 'signature_data_url', ...medicationFields]
      .forEach(field => allowedFields.add(field));
  }
  if (Object.keys(req.body || {}).some(key => !allowedFields.has(key) ||
      (typeof req.body[key] !== 'string' &&
       !(req.newPublication && medicationFields.has(key) && Array.isArray(req.body[key]) &&
         req.body[key].every(value => typeof value === 'string'))))) {
    return renderNewRecordForm(req, res, {
      statusCode: 400,
      errorMessage: 'The upload form contains invalid or repeated text fields. Use the provided form.'
    });
  }
  const formData = getFormData(req.body || {});
  const petId = parseUnsignedId(formData.petId);
  if (!petId) {
    return renderNewRecordForm(req, res, {
      formData,
      statusCode: 400,
      errorMessage: 'Select an existing registered pet before uploading a document.'
    });
  }

  const title = formData.title.trim();
  const sourceName = formData.sourceName.trim();
  const description = formData.description.trim();
  const recordDate = parseRecordDate(formData.recordDate);

  if (!title || title.length > 200 || !sourceName || sourceName.length > 200) {
    return renderNewRecordForm(req, res, {
      formData,
      petId,
      statusCode: 400,
      errorMessage: 'Enter a record title (up to 200 characters) and source name (up to 200 characters).'
    });
  }

  if (!recordDate.valid) {
    return renderNewRecordForm(req, res, {
      formData,
      petId,
      statusCode: 400,
      errorMessage: 'Enter a valid record date.'
    });
  }

  if (Buffer.byteLength(description, 'utf8') > 60000) {
    return renderNewRecordForm(req, res, {
      formData,
      petId,
      statusCode: 400,
      errorMessage: 'The description is too long. Keep it under 60 KB.'
    });
  }

  let pet;
  let categories;
  try {
    [pet, categories] = await Promise.all([
      medicalRecordModel.getPetById(petId),
      medicalRecordModel.getCategories()
    ]);
  } catch (error) {
    console.error('Medical record validation lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to validate the selected pet and category right now.');
  }

  if (!pet) {
    return renderNewRecordForm(req, res, {
      formData,
      petId: null,
      statusCode: 404,
      errorMessage: 'The selected pet does not exist. Choose an existing registered pet.'
    });
  }

  if (!categories.some(category => category.category_code === formData.categoryCode)) {
    return renderNewRecordForm(req, res, {
      formData,
      petId,
      statusCode: 400,
      errorMessage: 'Choose a medical record category from the available list.'
    });
  }

  const uploadedFile = req.file;
  if (!uploadedFile || !Buffer.isBuffer(uploadedFile.buffer) || uploadedFile.buffer.length === 0) {
    return renderNewRecordForm(req, res, {
      formData,
      petId,
      statusCode: 400,
      errorMessage: 'Choose a non-empty PDF, JPEG or PNG document to upload.'
    });
  }

  if (uploadedFile.buffer.length > MAX_MEDICAL_DOCUMENT_SIZE) {
    return renderNewRecordForm(req, res, {
      formData,
      petId,
      statusCode: 413,
      errorMessage: `The medical document exceeds the ${MAX_MEDICAL_DOCUMENT_SIZE / (1024 * 1024)} MB upload limit.`
    });
  }

  const documentMimeType = detectDocumentMimeType(uploadedFile.buffer);
  if (!documentMimeType) {
    return renderNewRecordForm(req, res, {
      formData,
      petId,
      statusCode: 400,
      errorMessage: 'The document content is not a supported PDF, JPEG or PNG file.'
    });
  }

  const extraction = { extractionStatus: 'not_extracted', text: null };
  try {
    await validateMedicalDocument(uploadedFile.buffer, documentMimeType);
  } catch (error) {
    if (error instanceof InvalidMedicalDocumentError) {
      return renderNewRecordForm(req, res, {
        formData,
        petId,
        statusCode: 400,
        errorMessage: error.message
      });
    }

    console.error('Medical document validation failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to validate the medical document right now.');
  }

  let storageKey;
  let createdRecordId = null;
  try {
    storageKey = await storeOriginalDocument(uploadedFile.buffer);
    uploadedFile.buffer = undefined;

    createdRecordId = await medicalRecordModel.createDraftRecord({
      petId,
      categoryCode: formData.categoryCode,
      title,
      sourceName,
      recordDate: recordDate.value,
      description: description || null,
      extractedText: extraction.text,
      extractionStatus: extraction.extractionStatus,
      originalFilename: normalizeOriginalFilename(uploadedFile.originalname),
      storageKey,
      documentMimeType,
      fileSizeBytes: uploadedFile.size,
      uploadedByAdminId: req.session.user.id
    });

  } catch (error) {
    const confirmedInsertFailure = typeof error.sqlState === 'string' &&
      /^(22|23|42)/.test(error.sqlState);
    if (storageKey && confirmedInsertFailure) {
      try {
        await removeOriginalDocument(storageKey);
      } catch (cleanupError) {
        console.error('Medical document cleanup failed:', cleanupError.code || 'UNKNOWN');
      }
    }

    console.error('Medical record draft could not be saved:', {
      code: error.code || 'UNKNOWN',
      cleanupCode: error.cleanupCode || undefined
    });
    return renderNewRecordForm(req, res, {
      formData,
      petId,
      statusCode: 500,
      errorMessage: !storageKey || confirmedInsertFailure
        ? 'The draft could not be saved. If storage cleanup failed, an administrator may need to remove an orphaned private file.'
        : req.newPublication
          ? 'The record save outcome is uncertain. Contact an administrator before retrying; the private file was retained for investigation.'
          : 'The draft save outcome is uncertain. Check the draft list before retrying; the private file was retained for investigation.'
    });
  }

  try {
    await recordAdminAuditAction(req, 'MEDICAL_RECORD_UPLOADED', {
      targetEntityType: 'medical_record',
      targetEntityId: createdRecordId,
      petId,
      medicalRecordId: createdRecordId,
      actionResult: 'success',
      summary: 'Draft medical record uploaded',
      categoryCode: formData.categoryCode,
      recordTitle: title
    }, { throwOnFailure: true });
  } catch (error) {
    console.error('Medical record upload audit failed:', error.code || 'UNKNOWN');
    if (req.newPublication) {
      return res.status(500).send(`The record was saved privately but its upload audit failed. Do not upload it again. Contact an administrator and provide record ID ${encodeURIComponent(createdRecordId)}.`);
    }
    req.flash('error', 'The draft was saved, but its upload audit could not be recorded. Contact an administrator; do not upload it again.');
    return res.redirect('/admin/medical-records');
  }

  if (req.newPublication) {
    try {
      const record = await medicalRecordModel.getDraftRecordById(createdRecordId);
      if (!record) throw new Error('Saved record not found');
      const entries = record.category_code === 'medication_history'
        ? await medicationRefillModel.getDraftMedicationEntries(createdRecordId)
        : [];
      if (String(record.pet_id) !== String(petId) || record.storage_key !== storageKey ||
          record.document_mime_type !== documentMimeType ||
          record.category_code !== formData.categoryCode || record.title !== title ||
          record.source_name !== sourceName || formatRecordDate(record.record_date) !== (recordDate.value || '') ||
          (record.description || '') !== description ||
          (record.extracted_document_text || '') !== (extraction.text || '') ||
          record.extraction_status !== extraction.extractionStatus || entries.length !== 0) {
        throw new Error('Saved record changed before review');
      }
      req.body.review_version = medicalReviewVersion(record, entries);
      req.params.id = String(createdRecordId);
      return updateDraftReview(req, res);
    } catch (error) {
      console.error('Saved medical record could not be prepared for publication:', error.code || 'UNKNOWN');
      return res.status(500).send(`The record was saved privately, but publication could not be prepared. Do not upload it again. Contact an administrator and provide record ID ${encodeURIComponent(createdRecordId)}.`);
    }
  }

  req.flash('success', 'Medical record saved privately for Admin review.');
  return res.redirect('/admin/medical-records');
}

async function publishNewRecord(req, res) {
  const body = req.body || {};
  const signature = parseDataUrl(body.signature_data_url);
  if (body.action !== 'publish' || body.confirm_publish !== 'yes' ||
      !signature || Buffer.from(signature.base64, 'base64').length === 0 ||
      Buffer.from(signature.base64, 'base64').length > 300 * 1024) {
    return renderNewRecordForm(req, res, {
      statusCode: 400,
      errorMessage: 'Review the original document, confirm your review and draw your signature before publishing.'
    });
  }
  if (body.category_code === 'medication_history') {
    const fieldNames = ['medication_name', 'medication_dosage', 'medication_frequency', 'medication_start_date', 'medication_end_date'];
    const counts = fieldNames.map(name => getRepeatedStringValues(body, name).length);
    const validation = validateMedicationEntries(getMedicationFormEntries(body));
    if (counts.some(count => count !== counts[0]) || validation.error) {
      return renderNewRecordForm(req, res, {
        statusCode: 400,
        errorMessage: validation.error || 'Medication fields must be provided together for each entry.'
      });
    }
  }
  try {
    if (!await medicalRecordModel.supportsPublicationWithoutExtraction()) {
      return renderNewRecordForm(req, res, {
        statusCode: 503,
        errorMessage: 'Publishing without document extraction is not yet available. An administrator must review and approve the required database change.'
      });
    }
    if (!await adminActivityModel.isFeatureReady()) {
      return renderNewRecordForm(req, res, {
        statusCode: 503,
        errorMessage: 'Publishing requires the Admin signature and audit tables. Contact an administrator.'
      });
    }
    if (body.category_code === 'medication_history' && !await medicationRefillModel.isFeatureReady()) {
      return renderNewRecordForm(req, res, {
        statusCode: 503,
        errorMessage: 'Structured medication review is unavailable. Contact an administrator.'
      });
    }
  } catch (error) {
    console.error('Medical publication readiness check failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to verify publication readiness right now.');
  }
  return createDraft(req, res);
}

function handleUploadError(req, res, error) {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return renderNewRecordForm(req, res, {
      statusCode: 413,
      errorMessage: `The medical document exceeds the ${MAX_MEDICAL_DOCUMENT_SIZE / (1024 * 1024)} MB upload limit.`
    });
  }

  const uploadErrors = {
    LIMIT_UNEXPECTED_FILE: 'Upload exactly one document using the medical document field.',
    LIMIT_FILE_COUNT: 'Too many files. Upload exactly one medical document.',
    LIMIT_FIELD_COUNT: 'The upload form contains too many text fields. Use the provided form.',
    LIMIT_PART_COUNT: 'The upload form contains too many parts. Submit the provided form with one document.',
    LIMIT_FIELD_VALUE: 'A text field exceeds the permitted size. Reduce its length and try again.',
    LIMIT_FIELD_KEY: 'An upload field name is too long. Use the provided form.'
  };
  if (uploadErrors[error.code]) {
    return renderNewRecordForm(req, res, {
      statusCode: 400,
      errorMessage: uploadErrors[error.code]
    });
  }

  if (/^(Unexpected end of (form|file)|Malformed part header|Multipart: Boundary not found)$/.test(error.message || '')) {
    return renderNewRecordForm(req, res, {
      statusCode: 400,
      errorMessage: 'The upload could not be read. Submit a valid form with one PDF, JPEG or PNG document.'
    });
  }
  console.error('Medical document upload failed:', error.code || 'UNKNOWN');
  return renderNewRecordForm(req, res, {
    statusCode: 500,
    errorMessage: 'Unable to receive the medical document right now. Please try again.'
  });
}

module.exports = {
  listManagement,
  reviewDraft,
  updateDraftReview,
  previewOriginalDocument,
  downloadOriginalDocument,
  newRecordForm,
  createDraft,
  publishNewRecord,
  handleUploadError
};
