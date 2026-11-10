const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');

const storageDirectory = path.join(os.tmpdir(), `pethub-owner-medical-${randomUUID()}`);
process.env.MEDICAL_RECORD_STORAGE_DIR = storageDirectory;

const privateMedicalStorage = require('../helpers/privateMedicalStorage');
const categories = [
  { category_code: 'x_rays_imaging', category_name: 'X-rays & Imaging' },
  { category_code: 'test_results', category_name: 'Test Results' },
  { category_code: 'medical_history', category_name: 'Medical History' },
  { category_code: 'lab_reports', category_name: 'Lab Reports' },
  { category_code: 'immunisation_records', category_name: 'Immunisation Records' },
  { category_code: 'medication_history', category_name: 'Medication History' }
];
const pets = [
  {
    id: 1,
    owner_id: 7,
    name: 'Milo',
    species: 'Dog',
    breed: 'Mixed breed',
    age: 4,
    avs_licence_number: 'LICENCE-1',
    microchip_id: 'CHIP-1',
    image: 'milo.jpg'
  }
];
const records = new Map();
const documentBytes = new Map();
let server;
let baseUrl;

const medicalRecordModel = {
  getCategories: async () => categories
    .filter(category => category.category_code !== 'lab_reports')
    .map(category => ({ ...category })),
  getOwnerPetById: async (petId, ownerId) =>
    pets.find(pet => pet.id === Number(petId) && pet.owner_id === ownerId) || null,
  getPublishedRecordsForOwnerPet: async (petId, ownerId) => Array.from(records.values())
    .filter(record =>
      record.pet_id === Number(petId) &&
      record.owner_id === ownerId &&
      record.category_code !== 'lab_reports' &&
      record.publication_status === 'published'
    )
    .map(record => ({ ...record })),
  getPublishedRecordForOwnerPet: async (petId, recordId, ownerId) => {
    const record = records.get(String(recordId));
    return record &&
      record.pet_id === Number(petId) &&
      record.owner_id === ownerId &&
      record.category_code !== 'lab_reports' &&
      record.publication_status === 'published'
      ? { ...record }
      : null;
  },
  getPublishedRecordDocumentForOwnerPet: async (petId, recordId, ownerId) => {
    const record = records.get(String(recordId));
    return record &&
      record.pet_id === Number(petId) &&
      record.owner_id === ownerId &&
      record.category_code !== 'lab_reports' &&
      record.publication_status === 'published'
      ? {
          id: record.id,
          original_filename: record.original_filename,
          storage_key: record.storage_key,
          document_mime_type: record.document_mime_type
        }
      : null;
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

const petModelPath = require.resolve('../models/petModel');
require.cache[petModelPath] = {
  id: petModelPath,
  filename: petModelPath,
  loaded: true,
  exports: { getPetsByOwner: (_ownerId, callback) => callback(null, []) },
  children: [],
  paths: []
};

async function createRecord(options = {}) {
  const id = String(records.size + 1);
  const imageOnly = options.imageOnly === true;
  const bytes = imageOnly
    ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1])
    : Buffer.from('%PDF-1.7\nOriginal document bytes\n%%EOF\n');
  const storageKey = await privateMedicalStorage.storeOriginalDocument(bytes);
  const categoryCode = options.categoryCode || (imageOnly ? 'x_rays_imaging' : 'test_results');
  const record = {
    id,
    pet_id: 1,
    owner_id: 7,
    pet_name: 'Milo',
    category_code: categoryCode,
    category_name: categories.find(category => category.category_code === categoryCode)?.category_name || 'Lab Reports',
    title: options.title || (imageOnly ? 'Reviewed X-ray' : 'Vaccination report'),
    source_name: 'Example Veterinary Clinic',
    record_date: '2026-10-12',
    description: 'Reviewed document.',
    extracted_document_text: imageOnly ? null : 'Reviewed line one\nReviewed line two',
    extraction_status: imageOnly ? 'image_only_reviewed' : 'successful',
    publication_status: options.publicationStatus || 'published',
    original_filename: imageOnly ? 'xray.png' : 'vaccination.pdf',
    storage_key: storageKey,
    document_mime_type: imageOnly ? 'image/png' : 'application/pdf'
  };
  records.set(id, record);
  documentBytes.set(id, bytes);
  return record;
}

async function login(role, userId = 7) {
  const response = await fetch(`${baseUrl}/test-login/${role}/${userId}`);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(session({
    secret: 'isolated-owner-medical-tests',
    resave: false,
    saveUninitialized: false
  }));
  app.get('/test-login/:role/:userId', (req, res) => {
    req.session.user = {
      id: Number(req.params.userId),
      name: 'Mock user',
      role: req.params.role
    };    res.sendStatus(204);
  });
  app.use(require('../routes/petRoutes'));
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
  delete process.env.MEDICAL_RECORD_STORAGE_DIR;
});

test('owner passport lists only published records and counts them by category', async () => {
  const published = await createRecord();
  const draft = await createRecord({
    title: 'Private draft record',
    publicationStatus: 'draft'
  });
  const cookie = await login('user');

  const response = await fetch(`${baseUrl}/pets/1/medical-records`, {
    headers: { Cookie: cookie }
  });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Milo's medical records/);
  assert.match(html, /Vaccination report/);
  assert.doesNotMatch(html, /Private draft record/);
  assert.match(html, /1 record/);
  assert.match(html, /0 records/);
  assert.match(html, new RegExp(`/pets/1/medical-records/${published.id}`));
  const categoryPositions = [
    'X-rays &amp; Imaging',
    'Test Results',
    'Medical History',
    'Immunisation Records',
    'Medication History'
  ].map(name => html.indexOf(`category-card-name">${name}`));
  assert.ok(categoryPositions.every((position, index) =>
    position >= 0 && (index === 0 || position > categoryPositions[index - 1])
  ));
  assert.equal((html.match(/<a\s+class="category-card/g) || []).length, 5);
  assert.doesNotMatch(html, /Lab Reports|lab_reports/);
  assert.equal(draft.publication_status, 'draft');

  const emptyCategory = await fetch(
    `${baseUrl}/pets/1/medical-records?category=x_rays_imaging`,
    { headers: { Cookie: cookie } }
  );
  assert.match(await emptyCategory.text(), /No medical records are available in this category yet\./);
});

test('retired Lab Reports content is unavailable by category, record and document URLs', async () => {
  const retiredRecord = await createRecord({
    categoryCode: 'lab_reports',
    title: 'Historical lab record'
  });
  const cookie = await login('user');

  const retiredCategory = await fetch(
    `${baseUrl}/pets/1/medical-records?category=lab_reports`,
    { headers: { Cookie: cookie } }
  );
  assert.equal(retiredCategory.status, 404);

  for (const route of [
    `/pets/1/medical-records/${retiredRecord.id}`,
    `/pets/1/medical-records/${retiredRecord.id}/document/preview`,
    `/pets/1/medical-records/${retiredRecord.id}/document/download`
  ]) {
    const response = await fetch(`${baseUrl}${route}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 404, `${route} should not expose retired content`);
  }
});

test('record detail escapes saved values and hides stored extracted text from the owner', async () => {
  const record = await createRecord({ title: '<script>alert(1)</script>' });
  const cookie = await login('user');

  const response = await fetch(
    `${baseUrl}/pets/1/medical-records/${record.id}`,
    { headers: { Cookie: cookie } }
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(record.extracted_document_text.includes('Reviewed line one\nReviewed line two'));
  assert.doesNotMatch(html, /Reviewed line one|Reviewed line two|Document text|extracted-text/i);
  assert.ok(html.includes('vaccination.pdf'));
  assert.ok(html.includes('View Original Document'));
  assert.ok(html.includes('Download Original Document'));
  assert.ok(!html.includes('Edit Medical Record'));
  assert.ok(!html.includes('Delete Medical Record'));
});

test('published original files are securely viewable and downloadable by their pet owner', async () => {
  const record = await createRecord();
  const cookie = await login('user');
  const basePath = `/pets/1/medical-records/${record.id}/document`;

  const preview = await fetch(`${baseUrl}${basePath}/preview`, {
    headers: { Cookie: cookie }
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-disposition'), 'inline');
  assert.equal(preview.headers.get('cache-control'), 'private, no-store');
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), documentBytes.get(record.id));

  const download = await fetch(`${baseUrl}${basePath}/download`, {
    headers: { Cookie: cookie }
  });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), documentBytes.get(record.id));
});

test('drafts, other owners, unauthenticated users and Admins cannot use owner records routes', async () => {
  const draft = await createRecord({ publicationStatus: 'draft' });
  const unauthenticated = await fetch(`${baseUrl}/pets/1/medical-records`, {
    redirect: 'manual'
  });
  assert.equal(unauthenticated.status, 302);
  assert.equal(unauthenticated.headers.get('location'), '/login');

  const otherOwnerCookie = await login('user', 8);
  const otherOwner = await fetch(`${baseUrl}/pets/1/medical-records`, {
    headers: { Cookie: otherOwnerCookie }
  });
  assert.equal(otherOwner.status, 404);

  const adminCookie = await login('admin');
  const admin = await fetch(`${baseUrl}/pets/1/medical-records`, {
    headers: { Cookie: adminCookie },
    redirect: 'manual'
  });
  assert.equal(admin.status, 302);
  assert.equal(admin.headers.get('location'), '/admin/dashboard');

  const ownerCookie = await login('user');
  const hiddenDetail = await fetch(
    `${baseUrl}/pets/1/medical-records/${draft.id}`,
    { headers: { Cookie: ownerCookie } }
  );
  const hiddenDocument = await fetch(
    `${baseUrl}/pets/1/medical-records/${draft.id}/document/download`,
    { headers: { Cookie: ownerCookie } }
  );
  assert.equal(hiddenDetail.status, 404);
  assert.equal(hiddenDocument.status, 404);
});

test('reviewed image-only X-rays keep the private original without displaying OCR text', async () => {
  const record = await createRecord({ imageOnly: true });
  const cookie = await login('user');
  const response = await fetch(`${baseUrl}/pets/1/medical-records/${record.id}`, {
    headers: { Cookie: cookie }
  });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /Document text|image-only X-ray|extracted text/i);
  assert.match(html, /View Original Document/);
  assert.match(html, /Download Original Document/);
});
