const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const pet = { id: 1, owner_id: 7, name: 'Milo', species: 'Dog', breed: 'Mixed' };
const medication = {
  id: 11, medical_record_id: 31, pet_id: 1, medication_name: 'Medication A',
  dosage: '1 tablet', frequency: 'Once daily', record_title: 'Reviewed record',
  source_name: 'Clinic', active_request_id: 42, active_request_status: 'Ready for Test Payment'
};
const record = {
  id: 31, pet_id: 1, category_code: 'medication_history',
  category_name: 'Medication History', title: 'Reviewed record',
  source_name: 'Clinic', original_filename: 'private.pdf'
};
const medicalPath = require.resolve('../models/medicalRecordModel');
require.cache[medicalPath] = {
  id: medicalPath, filename: medicalPath, loaded: true, children: [], paths: [],
  exports: {
    getCategories: async () => [{ category_code: 'medication_history', category_name: 'Medication History' }],
    getOwnerPetById: async (id, owner) => Number(id) === 1 && Number(owner) === 7 ? pet : null,
    getPublishedRecordsForOwnerPet: async () => [record],
    getPublishedRecordForOwnerPet: async (id, recordId, owner) =>
      Number(id) === 1 && String(recordId) === '31' && Number(owner) === 7 ? record : null
  }
};
let reviewCalls = [];
const refillPath = require.resolve('../models/medicationRefillModel');
require.cache[refillPath] = {
  id: refillPath, filename: refillPath, loaded: true, children: [], paths: [],
  exports: {
    isFeatureReady: async () => true,
    getPublishedMedicationEntriesForOwnerPet: async (id, owner) =>
      Number(id) === 1 && Number(owner) === 7 ? [medication, { ...medication, id: 12, medical_record_id: 32 }] : [],
    getMedicationEntryForOwnerPet: async (entry, id, owner) =>
      String(entry) === '11' && Number(id) === 1 && Number(owner) === 7 ? medication : null,
    getOwnerRefillRequests: async () => [{
      id: 42, medication_name: 'Medication A', record_title: 'Reviewed record',
      status: 'Ready for Test Payment', demo_price_cents: 1234
    }],
    getAdminRefillRequests: async () => [{
      id: 42, status: 'Pending', medication_name: 'Medication A', owner_name: 'Owner',
      owner_id: 7, pet_id: 1, pet_name: 'Milo', medical_record_id: 31, record_title: 'Reviewed record'
    }],
    updateAdminRefillRequest: async update => { reviewCalls.push(update); return true; }
  }
};

let server;
let base;
before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'offline-refill-tests', resave: false, saveUninitialized: false }));
  app.use(flash());
  app.get('/login/:role/:id', (req, res) => {
    req.session.user = { id: Number(req.params.id), role: req.params.role, name: 'Tester', username: 'test' };    req.session.csrfToken = 'test-token';
    res.sendStatus(204);
  });
  app.use(require('../routes/petRoutes'));
  app.use(require('../routes/adminRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
async function login(role, id) {
  const response = await fetch(`${base}/login/${role}/${id}`);
  return response.headers.get('set-cookie').split(';', 1)[0];
}
function csrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

test('category contains records once and detail shows only linked structured medication and private original', async () => {
  const cookie = await login('user', 7);
  const category = await fetch(`${base}/pets/1/medical-records?category=medication_history`, { headers: { Cookie: cookie } });
  const html = await category.text();
  assert.equal(category.status, 200);
  assert.match(html, /View Medical Record/);
  assert.doesNotMatch(html, /Medication A/);
  const detail = await fetch(`${base}/pets/1/medical-records/31`, { headers: { Cookie: cookie } });
  const detailHtml = await detail.text();
  assert.equal(detail.status, 200);
  assert.match(detailHtml, /Medication A/);
  assert.equal((detailHtml.match(/Medication A/g) || []).length, 1);
  assert.match(detailHtml, /1 tablet/);
  assert.match(detailHtml, /Once daily/);
  assert.match(detailHtml, /refill-requests#request-42/);
  assert.match(detailHtml, /document\/preview/);
  assert.match(detailHtml, /document\/download/);
  assert.doesNotMatch(detailHtml, /extracted_document_text/);
});

test('other owners and mismatched records cannot access medication and old submission requires CSRF', async () => {
  const other = await login('user', 8);
  assert.equal((await fetch(`${base}/pets/1/medical-records/31`, { headers: { Cookie: other } })).status, 404);
  const owner = await login('user', 7);
  assert.equal((await fetch(`${base}/pets/1/medical-records/999/refill-requests/11/new`, { headers: { Cookie: owner } })).status, 404);
  assert.equal((await fetch(`${base}/pets/1/medical-records/31/refill-requests/11/new`, {
    method: 'POST', headers: { Cookie: owner, 'Content-Type': 'application/x-www-form-urlencoded' }, body: ''
  })).status, 403);
});

test('new-request submission rejects incomplete requests and requires CSRF', async () => {
  const owner = await login('user', 7);
  const admin = await login('admin', 1);
  const page = await fetch(`${base}/admin/refill-requests`, { headers: { Cookie: admin } });
  const token = csrf(await page.text());
  const response = await fetch(`${base}/admin/refill-requests/42/review`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, status: 'Paid' })
  });
  assert.equal(response.status, 302);
  assert.equal(reviewCalls.length, 0);
  const noToken = await fetch(`${base}/pets/1/medical-records/31/refill-requests/11/new`, {
    method: 'POST', headers: { Cookie: owner, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  assert.equal(noToken.status, 403);
  const invalid = await fetch(`${base}/pets/1/medical-records/31/refill-requests/11/new`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: owner, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: 'test-token', reason: 'Running Low', quantity: '2' })
  });
  assert.equal(invalid.status, 302);
  assert.match(invalid.headers.get('location'), /medical-records\/31#medication-details/);
});

test('Admin can accept or reject but cannot choose clarification or Paid', async () => {
  const admin = await login('admin', 1);
  const page = await fetch(`${base}/admin/refill-requests`, { headers: { Cookie: admin } });
  const html = await page.text();
  assert.match(html, /Accepted with Demo Quotation/);
  assert.doesNotMatch(html, /<option value="More Information Required"/);
  const token = csrf(html);
  for (const status of ['Paid', 'More Information Required']) {
    await fetch(`${base}/admin/refill-requests/42/review`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: token, status })
    });
  }
  assert.equal(reviewCalls.length, 0);
  await fetch(`${base}/admin/refill-requests/42/review`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, status: 'Ready for Test Payment', demo_price: '12.34' })
  });
  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls[0].demoPriceCents, 1234);
  const user = await login('user', 7);
  assert.equal((await fetch(`${base}/admin/refill-requests`, { headers: { Cookie: user } })).status, 403);
});
