const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const storageDirectory = path.join(
  os.tmpdir(),
  `pethub-medical-review-${randomUUID()}`
);
process.env.MEDICAL_RECORD_STORAGE_DIR = storageDirectory;
process.env.MEDICAL_SIGNATURE_STORAGE_DIR = path.join(storageDirectory, 'signatures');

const connectionPath = require.resolve('../config/db');
const originalConnectionModule = require.cache[connectionPath];
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: {
    query() { throw new Error('Unexpected database query in medical record review test.'); },
    promise() {
      return {
        query() { throw new Error('Unexpected database query in medical record review test.'); },
        beginTransaction() { throw new Error('Unexpected database transaction in medical record review test.'); }
      };
    }
  },
  children: [],
  paths: []
};

const privateMedicalStorage = require('../helpers/privateMedicalStorage');
const adminActivityModel = require('../models/adminActivityModel');
const structuredMedicationEntries = new Map();
const medicationRefillModel = {
  isFeatureReady: async () => true,
  getDraftMedicationEntries: async recordId =>
    (structuredMedicationEntries.get(String(recordId)) || []).map(entry => ({ ...entry })),
  saveDraftMedicationReview: async review => {
    const record = records.get(String(review.id));
    if (!record || record.publication_status !== 'draft') return false;
    record.category_code = review.categoryCode;
    record.title = review.title;
    record.source_name = review.sourceName;
    record.record_date = review.recordDate;
    record.description = review.description;
    record.extracted_document_text = review.extractedText;
    structuredMedicationEntries.set(String(review.id), review.entries.map(entry => ({
      ...entry,
      recorded_by_admin_id: review.adminId
    })));
    return true;
  }
};
const medicationRefillModelPath = require.resolve('../models/medicationRefillModel');
require.cache[medicationRefillModelPath] = {
  id: medicationRefillModelPath,
  filename: medicationRefillModelPath,
  loaded: true,
  exports: medicationRefillModel,
  children: [],
  paths: []
};

const originalSignatureFlags = {
  require: process.env.PETHUB_REQUIRE_SIGNATURES,
  enable: process.env.PETHUB_ENABLE_SIGNATURES
};
delete process.env.PETHUB_REQUIRE_SIGNATURES;
delete process.env.PETHUB_ENABLE_SIGNATURES;

const auditEntries = [];
let nextAuditId = 1;
adminActivityModel.isFeatureReady = async () => false;
adminActivityModel.logAdminAction = async entry => {
  auditEntries.push(entry);
  return nextAuditId++;
};

const records = new Map();
const documentBytes = new Map();
let nextRecordId = 100;
let server;
let baseUrl;

const medicalRecordModel = {
  supportsPublicationWithoutExtraction: async () => true,
  searchRegisteredPets: async () => [{ id: 1, name: 'Mock Pet', owner_name: 'Mock Owner' }],
  getDraftRecords: async () => [],
  getCategories: async () => [
    { category_code: 'x_rays_imaging', category_name: 'X-rays & Imaging' },
    { category_code: 'test_results', category_name: 'Test Results' },
    { category_code: 'medical_history', category_name: 'Medical History' },
    { category_code: 'lab_reports', category_name: 'Lab Reports' },
    { category_code: 'immunisation_records', category_name: 'Immunisation Records' },
    { category_code: 'medication_history', category_name: 'Medication History' }
  ].filter(category => category.category_code !== 'lab_reports'),
  getPetById: async id => ({ id, name: 'Mock Pet' }),
  getDraftRecordById: async id => {
    const record = records.get(String(id));
    return record &&
      record.publication_status === 'draft' &&
      record.category_code !== 'lab_reports'
      ? { ...record }
      : null;
  },
  getRecordDocumentById: async id => {
    const record = records.get(String(id));
    return record && record.category_code !== 'lab_reports' ? { ...record } : null;
  },
  updateDraftRecord: async update => {
    const record = records.get(String(update.id));
    if (!record || record.publication_status !== 'draft') return false;
    Object.assign(record, {
      category_code: update.categoryCode,
      title: update.title,
      source_name: update.sourceName,
      record_date: update.recordDate,
      description: update.description,
      extracted_document_text: update.extractedText,
      extraction_status: update.extractionStatus,
      reviewed_by_admin_id: update.reviewedByAdminId,
      reviewed_at: new Date(),
      publication_status: update.publicationStatus,
      published_at: update.publicationStatus === 'published' ? new Date() : null
    });
    return true;
  }
};
const medicalRecordModelPath = require.resolve('../models/medicalRecordModel');
require.cache[medicalRecordModelPath] = {
  id: medicalRecordModelPath,
  filename: medicalRecordModelPath,
  loaded: true,
  exports: medicalRecordModel,
  children: [],
  paths: []
};

class InvalidMedicalDocumentError extends Error {}
const actualDetectDocumentMimeType = require('../helpers/medicalDocumentExtraction').detectDocumentMimeType;
let extractionCalls = 0;
let extractionResult = { extractionStatus: 'successful', text: 'Validated mock document content' };
const extraction = {
  InvalidMedicalDocumentError,
  detectDocumentMimeType: actualDetectDocumentMimeType,
  validateMedicalDocument: async () => {},
  extractMedicalDocumentText: async () => {
    extractionCalls += 1;
    return extractionResult;
  },
  hasMeaningfulText(text) {
    const characters = String(text || '').replace(/\s+/g, '');
    return characters.length >= 5 && (characters.match(/\p{L}/gu) || []).length >= 2;
  }
};
const extractionPath = require.resolve('../helpers/medicalDocumentExtraction');
require.cache[extractionPath] = {
  id: extractionPath,
  filename: extractionPath,
  loaded: true,
  exports: extraction,
  children: [],
  paths: []
};

function createPdfBytes() {
  return Buffer.from('%PDF-1.7\nMock original PDF bytes\n%%EOF\n');
}

async function createRecord(options = {}) {
  const id = String(++nextRecordId);
  const bytes = options.imageOnly
    ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1])
    : createPdfBytes();
  const storageKey = options.missingFile
    ? randomUUID()
    : await privateMedicalStorage.storeOriginalDocument(bytes);
  const categoryCode = options.categoryCode || (options.imageOnly ? 'x_rays_imaging' : 'test_results');
  const record = {
    id,
    pet_id: 1,
    pet_name: '<script>Pet</script>',
    microchip_id: 'MOCK-CHIP',
    avs_licence_number: 'MOCK-LICENCE',
    category_code: categoryCode,
    category_name: categoryCode === 'lab_reports' ? 'Lab Reports' :
      categoryCode === 'x_rays_imaging' ? 'X-rays & Imaging' : 'Test Results',
    title: '<script>alert(1)</script>',
    source_name: 'Mock veterinary clinic',
    record_date: null,
    description: 'Mock description',
    extracted_document_text: options.imageOnly ? null : 'Existing mock extracted text',
    extraction_status: options.imageOnly ? 'failed_review_needed' : 'successful',
    publication_status: 'draft',
    original_filename: 'mock-original.pdf',
    storage_key: storageKey,
    document_mime_type: options.imageOnly ? 'image/png' : 'application/pdf',
    file_size_bytes: bytes.length,
    uploaded_by_admin_id: 3,
    uploaded_by_admin_name: 'Mock uploader',
    uploaded_at: new Date()
  };
  records.set(id, record);
  documentBytes.set(id, bytes);
  return record;
}

async function login(role) {
  const response = await fetch(`${baseUrl}/test-login/${role}`);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'login should create a session cookie');
  return cookie.split(';', 1)[0];
}

async function reviewPage(cookie, recordId) {
  const response = await fetch(`${baseUrl}/admin/medical-records/${recordId}/review`, {
    headers: { Cookie: cookie }
  });
  return { response, html: await response.text() };
}

function getCsrfToken(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'review page should provide a CSRF token');
  return match[1];
}

function getReviewVersion(html) {
  const match = html.match(/name="review_version" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

function validReviewForm(token, fields = {}) {
  return new URLSearchParams({
    _csrf: token,
    action: 'publish',
    confirm_publish: 'yes',
    category_code: 'test_results',
    title: 'Reviewed test record',
    source_name: 'Mock veterinary clinic',
    record_date: '',
    description: 'Reviewed mock description',
    extracted_document_text: 'Reviewed mock result text',
    ...fields
  });
}

function validSignatureDataUrl() {
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB4L0jAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJ0UkGAAAAAElFTkSuQmCC';
}

before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(session({
    secret: 'isolated-medical-record-tests',
    resave: false,
    saveUninitialized: false
  }));
  app.use(flash());
  app.get('/test-login/:role', (req, res) => {
    req.session.user = {
      id: 7,
      username: 'mock-admin',
      name: 'Mock Admin',
      role: req.params.role
    };    res.sendStatus(204);
  });
  app.use(require('../routes/adminRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.close();
    server.closeAllConnections();
    server.unref();
  }
  await fs.rm(storageDirectory, { recursive: true, force: true });
  if (originalConnectionModule) require.cache[connectionPath] = originalConnectionModule;
  else delete require.cache[connectionPath];
  if (originalSignatureFlags.require === undefined) {
    delete process.env.PETHUB_REQUIRE_SIGNATURES;
  } else {
    process.env.PETHUB_REQUIRE_SIGNATURES = originalSignatureFlags.require;
  }
  if (originalSignatureFlags.enable === undefined) {
    delete process.env.PETHUB_ENABLE_SIGNATURES;
  } else {
    process.env.PETHUB_ENABLE_SIGNATURES = originalSignatureFlags.enable;
  }
  delete process.env.MEDICAL_RECORD_STORAGE_DIR;
});

test('review and original-document routes reject unauthenticated and User sessions', async () => {
  const record = await createRecord();
  const paths = [
    `/admin/medical-records/${record.id}/review`,
    `/admin/medical-records/${record.id}/document/preview`,
    `/admin/medical-records/${record.id}/document/download`
  ];

  for (const route of paths) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 401, `${route} should require authentication`);
  }
  const unauthenticatedPost = await fetch(`${baseUrl}${paths[0]}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=publish'
  });

  assert.equal(unauthenticatedPost.status, 401);

  const userCookie = await login('user');
  for (const route of paths) {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: { Cookie: userCookie }
    });
    assert.equal(response.status, 403, `${route} should reject User sessions`);
  }
  const userPost = await fetch(`${baseUrl}${paths[0]}`, {
    method: 'POST',
    headers: {
      Cookie: userCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'action=publish'
  });
  assert.equal(userPost.status, 403);
});

test('PDF preview renderer assets require Admin authentication', async () => {
  const userCookie = await login('user');
  const adminCookie = await login('admin');
  for (const file of ['pdf.mjs', 'pdf.worker.mjs']) {
    const url = `${baseUrl}/admin/medical-preview/${file}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Cookie: userCookie } })).status, 403);
    const response = await fetch(url, { headers: { Cookie: adminCookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    await response.arrayBuffer();
  }
});

test('Admin review page safely escapes medical metadata and document URLs are private', async () => {
  const record = await createRecord();
  const adminCookie = await login('admin');
  const { response, html } = await reviewPage(adminCookie, record.id);

  assert.equal(response.status, 200);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));

  const preview = await fetch(
    `${baseUrl}/admin/medical-records/${record.id}/document/preview`,
    { headers: { Cookie: adminCookie } }
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), documentBytes.get(record.id));

  const download = await fetch(
    `${baseUrl}/admin/medical-records/${record.id}/document/download`,
    { headers: { Cookie: adminCookie } }
  );
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), documentBytes.get(record.id));

  const publicFile = await fetch(`${baseUrl}/${record.storage_key}`);
  assert.equal(publicFile.status, 404);
  await assert.rejects(
    privateMedicalStorage.readOriginalDocument('../outside'),
    /Invalid private medical document key/
  );
});

test('Admin medical-record workflows expose exactly five categories and reject Lab Reports', async () => {
  const adminCookie = await login('admin');
  const newRecordPage = await fetch(`${baseUrl}/admin/medical-records/new`, {
    headers: { Cookie: adminCookie }
  });
  const newRecordHtml = await newRecordPage.text();
  assert.equal(newRecordPage.status, 200);
  const categoryOptions = [...newRecordHtml.matchAll(/<option value="([a-z_]+)"/g)]
    .map(match => match[1]);
  assert.deepEqual(categoryOptions.sort(), [
    'immunisation_records',
    'medical_history',
    'medication_history',
    'test_results',
    'x_rays_imaging'
  ]);
  assert.doesNotMatch(newRecordHtml, /Lab Reports|lab_reports/);

  const form = new FormData();
  form.set('pet_id', '1');
  form.set('_csrf', getCsrfToken(newRecordHtml));
  form.set('category_code', 'lab_reports');
  form.set('title', 'Retired category attempt');
  form.set('source_name', 'Mock clinic');
  const createResponse = await fetch(`${baseUrl}/admin/medical-records`, {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: form
  });
  assert.equal(createResponse.status, 400);
  assert.match(await createResponse.text(), /Choose a medical record category from the available list/);
  const invalidCsrf = new FormData();
  invalidCsrf.set('pet_id', '1');
  const denied = await fetch(`${baseUrl}/admin/medical-records`, {
    method: 'POST', headers: { Cookie: adminCookie }, body: invalidCsrf
  });
  assert.equal(denied.status, 403);

  const historicalRecord = await createRecord({ categoryCode: 'lab_reports' });
  const review = await reviewPage(adminCookie, historicalRecord.id);
  assert.equal(review.response.status, 404);
  for (const action of ['preview', 'download']) {
    const document = await fetch(
      `${baseUrl}/admin/medical-records/${historicalRecord.id}/document/${action}`,
      { headers: { Cookie: adminCookie } }
    );
    assert.equal(document.status, 404);
  }
  assert.equal(historicalRecord.publication_status, 'draft');
});

test('only manually entered structured medication details are saved during Admin review', async () => {
  const record = await createRecord({ categoryCode: 'medication_history' });
  const adminCookie = await login('admin');
  const { html } = await reviewPage(adminCookie, record.id);
  assert.match(html, /Structured Medication History/);
  assert.match(html, /Do not copy or infer medication facts from OCR text alone/);
  assert.doesNotMatch(
    html,
    /name="medication_name\[\]"[^>]*value="Existing mock extracted text"/
  );

  const response = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(html), {
      action: 'save_draft',
      confirm_publish: '',
      review_version: getReviewVersion(html),
      category_code: 'medication_history',
      extracted_document_text: 'Existing mock extracted text',
      'medication_name[]': 'Medication copied from reviewed source',
      'medication_dosage[]': '1 tablet',
      'medication_frequency[]': 'Once daily',
      'medication_start_date[]': '2026-10-01',
      'medication_end_date[]': ''
    })
  });

  assert.equal(response.status, 302);
  assert.equal(record.publication_status, 'draft');
  assert.equal(record.extracted_document_text, 'Existing mock extracted text');
  assert.deepEqual(structuredMedicationEntries.get(String(record.id)), [{
    medicationName: 'Medication copied from reviewed source',
    dosage: '1 tablet',
    frequency: 'Once daily',
    startDate: '2026-10-01',
    endDate: null,
    recorded_by_admin_id: 7
  }]);
});

test('medication publication fails closed when signature and audit tables are unavailable', async () => {
    const record = await createRecord({ categoryCode: 'medication_history' });
    const cookie = await login('admin');
    const { html } = await reviewPage(cookie, record.id);
    const response = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: validReviewForm(getCsrfToken(html), {
        category_code: 'medication_history', signature_data_url: validSignatureDataUrl(),
        review_version: getReviewVersion(html)
      })
    });
    assert.equal(response.status, 503);
    assert.equal(record.publication_status, 'draft');
    assert.equal(structuredMedicationEntries.has(String(record.id)), false);
});

test('medication publication sends the reviewed entries once and retains uncertain signature evidence', async () => {
    const originalReady = adminActivityModel.isFeatureReady;
    const originalPublish = adminActivityModel.publishMedicalRecord;
    adminActivityModel.isFeatureReady = async () => true;
    let submitted;
    adminActivityModel.publishMedicalRecord = async options => {
      submitted = options;
      const error = new Error('commit response lost');
      error.commitOutcomeUnknown = true;
      throw error;
    };
    try {
      const record = await createRecord({ categoryCode: 'medication_history' });
      const cookie = await login('admin');
      const { html } = await reviewPage(cookie, record.id);
      const response = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: validReviewForm(getCsrfToken(html), {
          category_code: 'medication_history',
          review_version: getReviewVersion(html),
          signature_data_url: validSignatureDataUrl(),
          'medication_name[]': 'Reviewed medicine',
          'medication_dosage[]': '1 tablet'
        })
      });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /outcome is uncertain/i);
      assert.equal(structuredMedicationEntries.has(String(record.id)), false);
      assert.equal(submitted.medicationEntries[0].medicationName, 'Reviewed medicine');
      assert.equal(submitted.reviewPayload.medicationEntries[0].medicationName, 'Reviewed medicine');
      assert.ok((await fs.stat(submitted.signatureData.filePath)).isFile());
    } finally {
      adminActivityModel.isFeatureReady = originalReady;
      adminActivityModel.publishMedicalRecord = originalPublish;
    }
});

test('review POST requires a valid session CSRF token', async () => {
  const record = await createRecord();
  const adminCookie = await login('admin');
  const response = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'action=save_draft'
  });
  assert.equal(response.status, 403);
  assert.equal(record.publication_status, 'draft');
});

test('Save Draft keeps publication private and does not change original bytes', async () => {
  const record = await createRecord();
  const originalBytes = Buffer.from(documentBytes.get(record.id));
  const adminCookie = await login('admin');
  const { html } = await reviewPage(adminCookie, record.id);
  const response = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(html), {
      action: 'save_draft',
      confirm_publish: ''
    })
  });

  assert.equal(response.status, 302);
  assert.equal(record.publication_status, 'draft');
  assert.equal(record.published_at, null);
  assert.equal(record.reviewed_by_admin_id, 7);
  assert.ok(record.reviewed_at instanceof Date);
  assert.deepEqual(await privateMedicalStorage.readOriginalDocument(record.storage_key), originalBytes);
  assert.ok(auditEntries.some(entry =>
    entry.adminId === 7 &&
    entry.adminUsername === 'mock-admin' &&
    entry.adminName === 'Mock Admin' &&
    entry.actionType === 'MEDICAL_RECORD_DRAFT_UPDATED'
  ));
});

test('publishing requires explicit confirmation, meaningful text, metadata and readable original', async () => {
  const adminCookie = await login('admin');

  const unconfirmed = await createRecord();
  const unconfirmedPage = await reviewPage(adminCookie, unconfirmed.id);
  const noConfirmation = await fetch(`${baseUrl}/admin/medical-records/${unconfirmed.id}/review`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(unconfirmedPage.html), { confirm_publish: '' })
  });
  assert.equal(noConfirmation.status, 400);
  assert.equal(unconfirmed.publication_status, 'draft');

  const missingText = await createRecord();
  const missingTextPage = await reviewPage(adminCookie, missingText.id);
  const noText = await fetch(`${baseUrl}/admin/medical-records/${missingText.id}/review`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(missingTextPage.html), { extracted_document_text: 'x' })
  });
  assert.equal(noText.status, 400);
  assert.equal(missingText.publication_status, 'draft');

  const invalidMetadata = await createRecord();
  const invalidMetadataPage = await reviewPage(adminCookie, invalidMetadata.id);
  const noTitle = await fetch(`${baseUrl}/admin/medical-records/${invalidMetadata.id}/review`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(invalidMetadataPage.html), { title: '' })
  });
  assert.equal(noTitle.status, 400);
  assert.equal(invalidMetadata.publication_status, 'draft');

  const missingFile = await createRecord({ missingFile: true });
  const missingFilePage = await reviewPage(adminCookie, missingFile.id);
  const unavailableOriginal = await fetch(`${baseUrl}/admin/medical-records/${missingFile.id}/review`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(missingFilePage.html))
  });
  assert.equal(unavailableOriginal.status, 400);
  assert.equal(missingFile.publication_status, 'draft');

  const invalidOriginal = await createRecord();
  await fs.writeFile(
    path.join(storageDirectory, invalidOriginal.storage_key),
    Buffer.from('not a PDF')
  );
  const invalidOriginalPage = await reviewPage(adminCookie, invalidOriginal.id);
  const unverifiableOriginal = await fetch(`${baseUrl}/admin/medical-records/${invalidOriginal.id}/review`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(invalidOriginalPage.html))
  });
  assert.equal(unverifiableOriginal.status, 400);
  assert.equal(invalidOriginal.publication_status, 'draft');
});

test('publication records reviewer and timestamps and rejects duplicate publication', async () => {
  const record = await createRecord();
  const adminCookie = await login('admin');
  const { html } = await reviewPage(adminCookie, record.id);
  const response = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(html))
  });

  assert.equal(response.status, 302);
  assert.equal(record.publication_status, 'published');
  assert.equal(record.reviewed_by_admin_id, 7);
  assert.ok(record.reviewed_at instanceof Date);
  assert.ok(record.published_at instanceof Date);
  assert.deepEqual(
    await privateMedicalStorage.readOriginalDocument(record.storage_key),
    documentBytes.get(record.id)
  );

  const repeatedPost = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(html))
  });
  assert.equal(repeatedPost.status, 404);
  const repeatedPage = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(repeatedPage.status, 404);
});

test('image-only publication is limited to confirmed image X-ray records and adds no findings', async () => {
  const record = await createRecord({ imageOnly: true });
  const adminCookie = await login('admin');
  const { html } = await reviewPage(adminCookie, record.id);
  const response = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(html), {
      category_code: 'x_rays_imaging',
      extracted_document_text: '',
      image_only_reviewed: 'yes'
    })
  });

  assert.equal(response.status, 302);
  assert.equal(record.publication_status, 'published');
  assert.equal(record.extraction_status, 'image_only_reviewed');
  assert.equal(record.extracted_document_text, null);

  const unrelatedCategory = await createRecord({ imageOnly: true });
  const unrelatedPage = await reviewPage(adminCookie, unrelatedCategory.id);
  const rejected = await fetch(`${baseUrl}/admin/medical-records/${unrelatedCategory.id}/review`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: validReviewForm(getCsrfToken(unrelatedPage.html), {
      category_code: 'test_results',
      extracted_document_text: '',
      image_only_reviewed: 'yes'
    })
  });
  assert.equal(rejected.status, 400);
  assert.equal(unrelatedCategory.publication_status, 'draft');
});

test('mock: fail-closed publication when required audit insertion fails', async () => {
  const originalPublish = adminActivityModel.publishMedicalRecord;
  const originalRequire = process.env.PETHUB_REQUIRE_SIGNATURES;
  const originalEnable = process.env.PETHUB_ENABLE_SIGNATURES;
  process.env.PETHUB_REQUIRE_SIGNATURES = '1';
  delete process.env.PETHUB_ENABLE_SIGNATURES;
  adminActivityModel.publishMedicalRecord = async () => {
    throw new Error('audit insertion failed');
  };

  try {
    const record = await createRecord();
    const adminCookie = await login('admin');
    const { html } = await reviewPage(adminCookie, record.id);
    const response = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: validReviewForm(getCsrfToken(html), {
        signature_data_url: validSignatureDataUrl()
      })
    });

    assert.equal(response.status, 400);
    assert.equal(record.publication_status, 'draft');
  } finally {
    adminActivityModel.publishMedicalRecord = originalPublish;
    if (originalRequire === undefined) {
      delete process.env.PETHUB_REQUIRE_SIGNATURES;
    } else {
      process.env.PETHUB_REQUIRE_SIGNATURES = originalRequire;
    }
    if (originalEnable === undefined) {
      delete process.env.PETHUB_ENABLE_SIGNATURES;
    } else {
      process.env.PETHUB_ENABLE_SIGNATURES = originalEnable;
    }
  }
});

test('mock: fail-closed publication when required signature storage or save fails', async () => {
  const originalPublish = adminActivityModel.publishMedicalRecord;
  const originalEnable = process.env.PETHUB_ENABLE_SIGNATURES;
  process.env.PETHUB_ENABLE_SIGNATURES = '1';
  delete process.env.PETHUB_REQUIRE_SIGNATURES;
  adminActivityModel.publishMedicalRecord = async () => {
    throw new Error('signature insertion failed');
  };

  try {
    const record = await createRecord();
    const adminCookie = await login('admin');
    const { html } = await reviewPage(adminCookie, record.id);
    const response = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: validReviewForm(getCsrfToken(html), {
        signature_data_url: validSignatureDataUrl()
      })
    });

    assert.equal(response.status, 400);
    assert.equal(record.publication_status, 'draft');
  } finally {
    adminActivityModel.publishMedicalRecord = originalPublish;
    if (originalEnable === undefined) {
      delete process.env.PETHUB_ENABLE_SIGNATURES;
    } else {
      process.env.PETHUB_ENABLE_SIGNATURES = originalEnable;
    }
    delete process.env.PETHUB_REQUIRE_SIGNATURES;
  }
});

test('invalid record IDs do not reach the record lookup', async () => {
  const adminCookie = await login('admin');
  for (const id of ['abc', '0', '1.2', '18446744073709551616']) {
    const response = await fetch(`${baseUrl}/admin/medical-records/${id}/review`, {
      headers: { Cookie: adminCookie }
    });
    assert.equal(response.status, 404);
  }
});

async function combinedUploadForm(cookie) {
  const response = await fetch(`${baseUrl}/admin/medical-records`, {
    headers: { Cookie: cookie }
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  const uploadMarkup = html.match(/<form method="post" action="\/admin\/medical-records\/publish" enctype="multipart\/form-data">([\s\S]*?)<\/form>/);
  assert.ok(uploadMarkup, 'management page must contain the publication form');

  const form = new FormData();
  form.set('_csrf', getCsrfToken(uploadMarkup[1]));
  form.set('pet_id', '1');
  form.set('category_code', 'medication_history');
  form.set('title', 'Medication history');
  form.set('source_name', 'Clinic');
  form.set('record_date', '2025-01-02');
  form.set('description', 'Reviewed after upload');
  form.set('medical_document', new Blob([createPdfBytes()], { type: 'application/pdf' }), 'record.pdf');
  return form;
}

async function postUpload(cookie, form) {
  return fetch(`${baseUrl}/admin/medical-records`, {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : {},
    body: form,
    redirect: 'manual'
  });
}

test('legacy upload route accepts seven fields and one PDF, preserving one private draft original', async () => {
  const adminCookie = await login('admin');
  const form = await combinedUploadForm(adminCookie);
  const saved = [];
  medicalRecordModel.createDraftRecord = async record => {
    saved.push(record);
    return 999;
  };
  const auditCount = auditEntries.length;
  const response = await postUpload(adminCookie, form);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/medical-records');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].petId, 1);
  assert.equal(saved[0].categoryCode, 'medication_history');
  assert.equal(saved[0].uploadedByAdminId, 7);
  assert.equal(saved[0].documentMimeType, 'application/pdf');
  assert.deepEqual(await privateMedicalStorage.readOriginalDocument(saved[0].storageKey), createPdfBytes());
  assert.equal(auditEntries.length, auditCount + 1);
  assert.equal(auditEntries.at(-1).medicalRecordId, 999);
});

test('medical upload enforces Admin, CSRF, file and field limits and file signatures', async () => {
  const adminCookie = await login('admin');
  const userCookie = await login('user');
  let inserts = 0;
  medicalRecordModel.createDraftRecord = async () => { inserts += 1; return 1000; };
  const originalFiles = (await fs.readdir(storageDirectory)).sort();

  assert.equal((await postUpload(null, await combinedUploadForm(adminCookie))).status, 401);
  assert.equal((await postUpload(userCookie, await combinedUploadForm(adminCookie))).status, 403);
  const noCsrf = await combinedUploadForm(adminCookie);
  noCsrf.delete('_csrf');
  assert.equal((await postUpload(adminCookie, noCsrf)).status, 403);

  const tooManyFields = await combinedUploadForm(adminCookie);
  tooManyFields.set('extra', 'unexpected');
  let response = await postUpload(adminCookie, tooManyFields);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /too many text fields/i);

  const tooManyFiles = await combinedUploadForm(adminCookie);
  tooManyFiles.append('medical_document', new Blob([createPdfBytes()], { type: 'application/pdf' }), 'another.pdf');
  response = await postUpload(adminCookie, tooManyFiles);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /too many files/i);

  const unexpectedFile = await combinedUploadForm(adminCookie);
  unexpectedFile.delete('medical_document');
  unexpectedFile.set('wrong_file', new Blob([createPdfBytes()], { type: 'application/pdf' }), 'record.pdf');
  response = await postUpload(adminCookie, unexpectedFile);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /medical document field/i);

  const tooLong = await combinedUploadForm(adminCookie);
  tooLong.set('description', 'x'.repeat(60002));
  response = await postUpload(adminCookie, tooLong);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /text field exceeds/i);

  const invalidFile = await combinedUploadForm(adminCookie);
  invalidFile.set('medical_document', new Blob(['not a PDF'], { type: 'application/pdf' }), 'fake.pdf');
  response = await postUpload(adminCookie, invalidFile);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /content is not a supported/i);

  const tooBig = await combinedUploadForm(adminCookie);
  const tooBigBytes = Buffer.alloc(10 * 1024 * 1024 + 1);
  createPdfBytes().copy(tooBigBytes);
  tooBig.set('medical_document', new Blob([tooBigBytes], { type: 'application/pdf' }), 'large.pdf');
  response = await postUpload(adminCookie, tooBig);
  assert.equal(response.status, 413);
  assert.match(await response.text(), /exceeds the 10 MB/i);

  response = await fetch(`${baseUrl}/admin/medical-records`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'multipart/form-data; boundary=broken' },
    body: '--broken\r\nContent-Disposition: form-data; name="title"\r\n\r\nunfinished',
    redirect: 'manual'
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /upload could not be read/i);

  const duplicateField = await combinedUploadForm(adminCookie);
  duplicateField.delete('description');
  duplicateField.append('title', 'Second title');
  response = await postUpload(adminCookie, duplicateField);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /invalid or repeated text fields/i);
  assert.equal(inserts, 0);
  assert.deepEqual((await fs.readdir(storageDirectory)).sort(), originalFiles);
});

test('the 10 MB document boundary is accepted', async () => {
  const adminCookie = await login('admin');
  const form = await combinedUploadForm(adminCookie);
  const bytes = Buffer.alloc(10 * 1024 * 1024);
  createPdfBytes().copy(bytes);
  form.set('medical_document', new Blob([bytes], { type: 'application/pdf' }), 'boundary.pdf');
  let saved;
  medicalRecordModel.createDraftRecord = async record => { saved = record; return 1001; };
  const response = await postUpload(adminCookie, form);
  assert.equal(response.status, 302);
  assert.equal(saved.fileSizeBytes, bytes.length);
  assert.deepEqual(await privateMedicalStorage.readOriginalDocument(saved.storageKey), bytes);
});

test('upload failures clean up only confirmed failed inserts and preserve uncertain or saved originals', async () => {
  const adminCookie = await login('admin');
  let files = (await fs.readdir(storageDirectory)).sort();
  medicalRecordModel.createDraftRecord = async () => {
    const error = new Error('Rejected insert');
    error.sqlState = '23000';
    throw error;
  };
  let response = await postUpload(adminCookie, await combinedUploadForm(adminCookie));
  assert.equal(response.status, 500);
  assert.match(await response.text(), /draft could not be saved/i);
  assert.deepEqual((await fs.readdir(storageDirectory)).sort(), files);

  medicalRecordModel.createDraftRecord = async () => { throw new Error('Connection lost'); };
  response = await postUpload(adminCookie, await combinedUploadForm(adminCookie));
  assert.equal(response.status, 500);
  assert.match(await response.text(), /outcome is uncertain.*check the draft list/i);
  const retained = (await fs.readdir(storageDirectory)).filter(file => !files.includes(file));
  assert.equal(retained.length, 1);
  assert.deepEqual(await privateMedicalStorage.readOriginalDocument(retained[0]), createPdfBytes());
  files = (await fs.readdir(storageDirectory)).sort();

  let saved;
  let inserts = 0;
  medicalRecordModel.createDraftRecord = async record => { inserts += 1; saved = record; return 1002; };
  const originalAudit = adminActivityModel.logAdminAction;
  adminActivityModel.logAdminAction = async () => { throw new Error('Audit unavailable'); };
  try {
    response = await postUpload(adminCookie, await combinedUploadForm(adminCookie));
    assert.equal(response.status, 302);
    assert.equal(inserts, 1);
    assert.deepEqual(await privateMedicalStorage.readOriginalDocument(saved.storageKey), createPdfBytes());
    assert.equal((await fs.readdir(storageDirectory)).length, files.length + 1);
    const list = await fetch(`${baseUrl}/admin/medical-records`, { headers: { Cookie: adminCookie } });
    assert.match(await list.text(), /draft was saved.*audit could not be recorded/i);
    adminActivityModel.logAdminAction = async () => null;
    response = await postUpload(adminCookie, await combinedUploadForm(adminCookie));
    assert.equal(response.status, 302);
    assert.equal(inserts, 2);
    assert.deepEqual(await privateMedicalStorage.readOriginalDocument(saved.storageKey), createPdfBytes());
    const listWithMissingAudit = await fetch(`${baseUrl}/admin/medical-records`, { headers: { Cookie: adminCookie } });
    assert.match(await listWithMissingAudit.text(), /draft was saved.*audit could not be recorded/i);
  } finally {
    adminActivityModel.logAdminAction = originalAudit;
  }
});

async function onePageForm(cookie, entries = 1) {
  const form = await combinedUploadForm(cookie);
  form.set('action', 'publish');
  form.set('confirm_publish', 'yes');
  form.set('signature_data_url', validSignatureDataUrl());
  for (let index = 0; index < entries; index += 1) {
    form.append('medication_name[]', `Medicine ${index + 1}`);
    form.append('medication_dosage[]', '1 tablet');
    form.append('medication_frequency[]', 'Daily');
    form.append('medication_start_date[]', '');
    form.append('medication_end_date[]', '');
  }
  return form;
}

async function postPublication(cookie, form) {
  return fetch(`${baseUrl}/admin/medical-records/publish`, {
    method: 'POST', headers: cookie ? { Cookie: cookie } : {}, body: form, redirect: 'manual'
  });
}

test('one-page publication submits ten medication entries through the signed review transaction', async () => {
  const cookie = await login('admin');
  const html = await (await fetch(`${baseUrl}/admin/medical-records`, { headers: { Cookie: cookie } })).text();
  assert.match(html, /Publish Medical Record/);
  assert.doesNotMatch(html, /Create a private draft|Awaiting Admin review|Draft records/i);
  const originalReady = adminActivityModel.isFeatureReady;
  const originalPublish = adminActivityModel.publishMedicalRecord;
  const originalCreate = medicalRecordModel.createDraftRecord;
  const originalSupports = medicalRecordModel.supportsPublicationWithoutExtraction;
  medicalRecordModel.supportsPublicationWithoutExtraction = async () => false;
  adminActivityModel.isFeatureReady = async () => true;
  let inserted;
  let publication;
  let insertCount = 0;
  medicalRecordModel.createDraftRecord = async data => {
    insertCount += 1;
    inserted = data;
    records.set('1200', {
      id: '1200', pet_id: data.petId, pet_name: 'Mock Pet',
      category_code: data.categoryCode, category_name: 'Medication History',
      title: data.title, source_name: data.sourceName, record_date: data.recordDate,
      description: data.description, extracted_document_text: data.extractedText,
      extraction_status: data.extractionStatus, publication_status: 'draft',
      original_filename: data.originalFilename, storage_key: data.storageKey,
      document_mime_type: data.documentMimeType, file_size_bytes: data.fileSizeBytes,
      uploaded_by_admin_id: data.uploadedByAdminId, uploaded_by_admin_name: 'Mock Admin',
      uploaded_at: new Date()
    });
    return 1200;
  };
  adminActivityModel.publishMedicalRecord = async data => { publication = data; };
  try {
    const response = await postPublication(cookie, await onePageForm(cookie, 10));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin/medical-records');
    assert.equal(insertCount, 1);
    assert.equal(publication.medicationEntries.length, 10);
    assert.equal(publication.medicationEntries[9].medicationName, 'Medicine 10');
    assert.equal(publication.reviewPayload.extractedText, 'Validated mock document content');
    assert.equal(publication.recordSnapshot.extractionStatus, 'successful');
    assert.equal(publication.recordSnapshot.extractedText, 'Validated mock document content');
    assert.equal(publication.enforceRecordVersion, true);
    assert.equal(publication.recordSnapshot.storageKey, inserted.storageKey);
    assert.deepEqual(publication.originalDocument, createPdfBytes());
    assert.deepEqual(await privateMedicalStorage.readOriginalDocument(inserted.storageKey), createPdfBytes());
    assert.ok((await fs.stat(publication.signatureData.filePath)).isFile());

    adminActivityModel.publishMedicalRecord = async data => {
      publication = data;
      throw new Error('Audit insert failed');
    };
    const failed = await postPublication(cookie, await onePageForm(cookie));
    assert.equal(failed.status, 400);
    assert.match(await failed.text(), /saved privately.*do not upload it again/i);
    assert.deepEqual(await privateMedicalStorage.readOriginalDocument(inserted.storageKey), createPdfBytes());
    await assert.rejects(fs.stat(publication.signatureData.filePath), { code: 'ENOENT' });

    adminActivityModel.publishMedicalRecord = async data => {
      publication = data;
      const error = new Error('Commit response lost');
      error.commitOutcomeUnknown = true;
      throw error;
    };
    const uncertain = await postPublication(cookie, await onePageForm(cookie));
    assert.equal(uncertain.status, 400);
    const uncertainHtml = await uncertain.text();
    assert.match(uncertainHtml, /publication outcome is uncertain/i);
    assert.match(uncertainHtml, /do not upload it again/i);
    assert.ok((await fs.stat(publication.signatureData.filePath)).isFile());
  } finally {
    medicalRecordModel.supportsPublicationWithoutExtraction = originalSupports;
    medicalRecordModel.createDraftRecord = originalCreate;
    adminActivityModel.isFeatureReady = originalReady;
    adminActivityModel.publishMedicalRecord = originalPublish;
  }
});

test('one-page publication requires Admin, CSRF, signature and valid medications before creating a record', async () => {
  const cookie = await login('admin');
  const user = await login('user');
  const originalReady = adminActivityModel.isFeatureReady;
  const originalCreate = medicalRecordModel.createDraftRecord;
  let inserts = 0;
  adminActivityModel.isFeatureReady = async () => true;
  medicalRecordModel.createDraftRecord = async () => { inserts += 1; return 1201; };
  try {
    assert.equal((await postPublication(null, await onePageForm(cookie))).status, 401);
    assert.equal((await postPublication(user, await onePageForm(cookie))).status, 403);
    let form = await onePageForm(cookie);
    form.delete('_csrf');
    assert.equal((await postPublication(cookie, form)).status, 403);
    form = await onePageForm(cookie);
    form.delete('signature_data_url');
    assert.equal((await postPublication(cookie, form)).status, 400);
    form = await onePageForm(cookie);
    form.set('medication_end_date[]', '2020-01-01');
    form.set('medication_start_date[]', '2021-01-01');
    assert.equal((await postPublication(cookie, form)).status, 400);
    form = await onePageForm(cookie, 11);
    const tooMany = await postPublication(cookie, form);
    assert.equal(tooMany.status, 400);
    assert.match(await tooMany.text(), /too many text fields|at most 10/i);
    form = await onePageForm(cookie);
    form.set('medical_document', new Blob(['not a PDF'], { type: 'application/pdf' }), 'fake.pdf');
    assert.equal((await postPublication(cookie, form)).status, 400);
    form = await onePageForm(cookie);
    form.append('medical_document', new Blob([createPdfBytes()], { type: 'application/pdf' }), 'second.pdf');
    const extraFile = await postPublication(cookie, form);
    assert.equal(extraFile.status, 400);
    assert.match(await extraFile.text(), /too many files/i);
    assert.equal(inserts, 0);
  } finally {
    medicalRecordModel.createDraftRecord = originalCreate;
    adminActivityModel.isFeatureReady = originalReady;
  }
});

test('one-page publication accepts each supported type in each category with extracted text', async () => {
  const cookie = await login('admin');
  const originalReady = adminActivityModel.isFeatureReady;
  const originalPublish = adminActivityModel.publishMedicalRecord;
  const originalCreate = medicalRecordModel.createDraftRecord;
  adminActivityModel.isFeatureReady = async () => true;
  const initialExtractionCalls = extractionCalls;
  let inserted;
  let published;
  medicalRecordModel.createDraftRecord = async data => {
    inserted = data;
    records.set('1300', {
      id: '1300', pet_id: data.petId, pet_name: 'Mock Pet',
      category_code: data.categoryCode, category_name: 'Record',
      title: data.title, source_name: data.sourceName, record_date: data.recordDate,
      description: data.description, extracted_document_text: data.extractedText,
      extraction_status: data.extractionStatus, publication_status: 'draft',
      original_filename: data.originalFilename, storage_key: data.storageKey,
      document_mime_type: data.documentMimeType, file_size_bytes: data.fileSizeBytes,
      uploaded_by_admin_id: data.uploadedByAdminId, uploaded_by_admin_name: 'Mock Admin',
      uploaded_at: new Date()
    });
    return 1300;
  };
  adminActivityModel.publishMedicalRecord = async data => { published = data; };
  try {
    const canvas = require('@napi-rs/canvas').createCanvas(2, 2);
    const formats = [
      ['application/pdf', createPdfBytes()],
      ['image/jpeg', canvas.toBuffer('image/jpeg')],
      ['image/png', canvas.toBuffer('image/png')]
    ];
    for (const category of ['x_rays_imaging', 'test_results', 'medical_history', 'immunisation_records', 'medication_history']) {
      for (const [mime, bytes] of formats) {
        const form = await onePageForm(cookie, category === 'medication_history' ? 1 : 0);
        form.set('category_code', category);
        form.set('medical_document', new Blob([bytes], { type: mime }), 'document');
        const response = await postPublication(cookie, form);
        assert.equal(response.status, 302, `${category} ${mime}`);
        assert.equal(inserted.documentMimeType, mime);
        assert.equal(inserted.extractionStatus, 'successful');
        assert.equal(inserted.extractedText, 'Validated mock document content');
        assert.equal(published.recordSnapshot.extractionStatus, 'successful');
        assert.equal(published.recordSnapshot.extractedText, 'Validated mock document content');
      }
    }
    assert.equal(extractionCalls, initialExtractionCalls + 15);
  } finally {
    medicalRecordModel.createDraftRecord = originalCreate;
    adminActivityModel.isFeatureReady = originalReady;
    adminActivityModel.publishMedicalRecord = originalPublish;
  }
});

test('one-page publication reports the extraction failure instead of a database message when the no-extraction constraint is absent', async () => {
  const cookie = await login('admin');
  const original = medicalRecordModel.supportsPublicationWithoutExtraction;
  const originalCreate = medicalRecordModel.createDraftRecord;
  const originalResult = extractionResult;
  const originalReady = adminActivityModel.isFeatureReady;
  let inserts = 0;
  adminActivityModel.isFeatureReady = async () => true;
  medicalRecordModel.supportsPublicationWithoutExtraction = async () => false;
  medicalRecordModel.createDraftRecord = async () => { inserts += 1; };
  try {
    extractionResult = { extractionStatus: 'failed_review_needed', text: '' };
    const response = await postPublication(cookie, await onePageForm(cookie));
    assert.equal(response.status, 422);
    const html = await response.text();
    assert.match(html, /No readable text could be extracted/i);
    assert.doesNotMatch(html, /database change/i);
    assert.equal(inserts, 0);
  } finally {
    adminActivityModel.isFeatureReady = originalReady;
    extractionResult = originalResult;
    medicalRecordModel.supportsPublicationWithoutExtraction = original;
    medicalRecordModel.createDraftRecord = originalCreate;
  }
});

test('a saved no-extraction record can be recovered without OCR or source-text entry', async () => {
  const record = await createRecord();
  record.extraction_status = 'not_extracted';
  record.extracted_document_text = null;
  const cookie = await login('admin');
  const { html } = await reviewPage(cookie, record.id);
  assert.doesNotMatch(html, /name="extracted_document_text"/);
  const originalReady = adminActivityModel.isFeatureReady;
  const originalPublish = adminActivityModel.publishMedicalRecord;
  adminActivityModel.isFeatureReady = async () => true;
  let published;
  adminActivityModel.publishMedicalRecord = async data => { published = data; };
  const initialCalls = extractionCalls;
  try {
    const body = validReviewForm(getCsrfToken(html), {
      extracted_document_text: '',
      signature_data_url: validSignatureDataUrl()
    });
    const response = await fetch(`${baseUrl}/admin/medical-records/${record.id}/review`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body, redirect: 'manual'
    });
    assert.equal(response.status, 302);
    assert.equal(published.recordSnapshot.extractionStatus, 'not_extracted');
    assert.equal(published.recordSnapshot.extractedText, null);
    assert.equal(extractionCalls, initialCalls);
  } finally {
    adminActivityModel.isFeatureReady = originalReady;
    adminActivityModel.publishMedicalRecord = originalPublish;
  }
});
