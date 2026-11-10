const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const pet = { id: 1, owner_id: 7, name: 'Milo' };
const record = { id: 31, pet_id: 1, category_code: 'medication_history', category_name: 'Medication History', title: 'Record', source_name: 'Clinic', original_filename: 'record.pdf' };
const medications = [
  { id: 11, medical_record_id: 31, pet_id: 1, medication_name: 'Demo medicine', dosage: '1 tablet', refill_quantity_unit: null },
  { id: 12, medical_record_id: 31, pet_id: 1, medication_name: 'Documented medicine', dosage: '2 mL', refill_quantity_unit: 'mL' }
];
const requests = [];
function mock(module, exports) {
  const resolved = require.resolve(module);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, children: [], paths: [], exports };
}
mock('../models/medicalRecordModel', {
  getOwnerPetById: async (id, owner) => Number(id) === 1 && owner === 7 ? pet : null,
  getPublishedRecordForOwnerPet: async (id, recordId, owner) => Number(id) === 1 && recordId === '31' && owner === 7 ? record : null
});
mock('../models/petModel', { getPetsByOwner: (_id, cb) => cb(null, [pet]) });
mock('../models/petShopModel', { isFeatureReady: async () => false });
mock('../models/appointmentModel', { nextForOwner: async () => null });
mock('../models/medicationRefillModel', {
  isFeatureReady: async () => true,
  getMedicationEntryForOwnerPet: async (entry, id, owner) =>
    Number(id) === 1 && owner === 7 ? medications.find(m => String(m.id) === entry) : null,
  getPublishedMedicationEntriesForOwnerPet: async () => medications.map(m => {
    const last = requests.filter(r => r.medication_entry_id === m.id).at(-1);
    const active = last && !['Rejected', 'Paid'].includes(last.status) ? last : null;
    return { ...m, active_request_id: active && active.id, active_request_status: active && active.status,
      last_request_id: last && last.id, last_request_status: last && last.status };
  }),
  createOwnerRefillRequest: async input => {
    const duplicate = requests.find(r => r.request_key === input.requestKey);
    if (duplicate) return { id: duplicate.id, duplicateSubmission: true };
    if (requests.some(r => r.medication_entry_id === Number(input.medicationEntryId) && r.status !== 'Rejected')) {
      const error = new Error('active');
      error.code = 'ACTIVE_REQUEST_EXISTS';
      throw error;
    }
    const medication = medications.find(m => String(m.id) === input.medicationEntryId);
    const request = {
      id: requests.length + 1, request_key: input.requestKey, medication_entry_id: medication.id,
      medication_name: medication.medication_name, dosage: medication.dosage,
      pet_id: 1, pet_name: pet.name, owner_id: 7, owner_name: 'Owner',
      medical_record_id: 31, record_title: record.title, status: 'Pending',
      refill_reason: input.reason, requested_quantity: input.quantity, requested_quantity_unit: input.unit
    };
    requests.push(request);
    return { id: request.id, duplicateSubmission: false };
  },
  getOwnerRefillRequests: async (_pet, owner) => requests.filter(r => r.owner_id === owner),
  getAdminRefillRequests: async () => requests,
  updateAdminRefillRequest: async update => {
    const request = requests.find(r => String(r.id) === update.requestId && r.status === 'Pending');
    if (!request) return false;
    request.status = update.status;
    request.demo_price_cents = update.demoPriceCents;
    request.admin_review_note = update.reviewNote;
    return true;
  },
  getOwnerAcceptedDemoRefills: async owner => requests.filter(r => r.owner_id === owner && r.status === 'Ready for Test Payment')
});

let server;
let base;
before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'offline-workflow', resave: false, saveUninitialized: false }));
  app.use(flash());
  app.get('/test-login/:role/:id', (req, res) => {
    req.session.user = { id: Number(req.params.id), role: req.params.role, name: 'Tester', username: 'test' };    req.session.csrfToken = `token-${req.params.role}-${req.params.id}`;
    res.sendStatus(204);
  });
  app.use(require('../routes/petRoutes'));
  app.use(require('../routes/adminRoutes'));
  app.use(require('../routes/indexRoutes'));
  const { isPetOwner } = require('../middleware/auth');
  const { csrfToken } = require('../middleware/csrf');
  app.get('/refill-cart', isPetOwner, csrfToken, require('../controllers/refillCartController').viewCart);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
async function login(role, id) {
  return (await fetch(`${base}/test-login/${role}/${id}`)).headers.get('set-cookie').split(';', 1)[0];
}
async function get(url, cookie) {
  const response = await fetch(base + url, { headers: { Cookie: cookie }, redirect: 'manual' });
  return { response, html: await response.text() };
}
async function post(url, cookie, fields) {
  return fetch(base + url, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields) });
}
function field(html, name) {
  const found = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert.ok(found, `missing ${name}`);
  return found[1];
}

test('owner to admin refill flow, validation, rejection, acceptance, cart and reminder', async () => {
  const owner = await login('user', 7);
  const other = await login('user', 8);
  const admin = await login('admin', 1);
  const detail = '/pets/1/medical-records/31';
  const submit = `${detail}/refill-requests/11/new`;
  const emptyAdminPage = await get('/admin/refill-requests', admin);
  assert.equal(emptyAdminPage.response.status, 200);
  assert.match(emptyAdminPage.html, /No refill requests have been submitted/);
  assert.equal((await get('/admin/refill-requests', other)).response.status, 403);
  let page = await get(detail, owner);
  assert.equal(page.response.status, 200);
  assert.match(page.html, /DEMO quantity unit/);
  assert.match(page.html, /not veterinary verified/);
  assert.match(page.html, /Documented quantity unit/);
  const token = field(page.html, '_csrf');
  const key = field(page.html, 'request_key');
  const input = { _csrf: token, request_key: key, refill_reason: 'Running Low', requested_quantity: '3', requested_quantity_unit: 'tablets' };
  assert.equal((await post(submit, owner, { ...input, _csrf: '' })).status, 403);
  assert.equal((await post(submit, other, input)).status, 403);
  assert.equal((await post(submit, other, { ...input, _csrf: 'token-user-8' })).status, 404);
  for (const invalid of [
    { requested_quantity: '0' }, { requested_quantity: '1.5' }, { requested_quantity: '4294967296' },
    { requested_quantity_unit: '' }, { requested_quantity_unit: 'invalid' }, { refill_reason: 'Invalid' }
  ]) {
    assert.equal((await post(submit, owner, { ...input, ...invalid })).status, 302);
    assert.equal(requests.length, 0);
  }
  assert.equal((await post('/pets/1/medical-records/99/refill-requests/11/new', owner, input)).status, 404);
  let result = await post(submit, owner, input);
  assert.match(result.headers.get('location'), /submitted=yes/);
  assert.equal(requests.length, 1);
  page = await get('/dashboard', owner);
  assert.doesNotMatch(page.html, /Medication Refill Payment Reminder/);
  result = await post(submit, owner, input);
  assert.match(result.headers.get('location'), /submitted=again/);
  result = await post(submit, owner, { ...input, request_key: '12345678-1234-4123-8123-123456789abc' });
  assert.match(result.headers.get('location'), /submitted=existing/);
  page = await get('/pets/1/medical-records/refill-requests', owner);
  assert.match(page.html, /Pending/);
  assert.match(page.html, /Running Low/);
  assert.match(page.html, /3 tablets/);
  page = await get('/admin/refill-requests', admin);
  assert.match(page.html, /Running Low/);
  assert.match(page.html, /3 tablets/);
  const adminToken = field(page.html, '_csrf');
  await post('/admin/refill-requests/1/review', admin, { _csrf: adminToken, status: 'Ready for Test Payment', demo_price: '0' });
  assert.equal(requests[0].status, 'Pending');
  await post('/admin/refill-requests/1/review', admin, { _csrf: adminToken, status: 'Rejected' });
  page = await get('/dashboard', owner);
  assert.doesNotMatch(page.html, /Medication Refill Payment Reminder/);
  page = await get(detail, owner);
  assert.match(page.html, /Rejected/);
  const next = { ...input, request_key: field(page.html, 'request_key') };
  await post(submit, owner, next);
  await post('/admin/refill-requests/2/review', admin, { _csrf: adminToken, status: 'Ready for Test Payment', demo_price: '12.34' });
  page = await get('/pets/1/medical-records/refill-requests', owner);
  assert.match(page.html, /Accepted with Demo Quotation/);
  assert.match(page.html, /SGD 12\.34/);
  page = await get('/refill-cart', owner);
  assert.match(page.html, /3 tablets/);
  assert.match(page.html, /S\$12\.34/);
  page = await get('/dashboard', owner);
  assert.match(page.html, /Medication Refill Payment Reminder/);
  assert.match(page.html, /Ready for Test Payment/);
  const otherDashboard = await get('/dashboard', other);
  assert.doesNotMatch(otherDashboard.html, /Medication Refill Payment Reminder|Demo medicine/);
  requests[1].status = 'Paid';
  page = await get('/dashboard', owner);
  assert.doesNotMatch(page.html, /Medication Refill Payment Reminder/);
  requests[1].status = 'Ready for Test Payment';
  page = await get('/dashboard', owner);
  assert.match(page.html, /Demo medicine/);
  assert.match(page.html, /S\$12\.34/);
  page = await get(detail, owner);
  const documentedKey = field(page.html, 'request_key');
  const documentedSubmit = `${detail}/refill-requests/12/new`;
  await post(documentedSubmit, owner, { ...input, request_key: documentedKey, requested_quantity_unit: 'tablets' });
  assert.equal(requests.length, 2);
  await post(documentedSubmit, owner, { ...input, request_key: documentedKey, requested_quantity_unit: 'mL' });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].requested_quantity_unit, 'mL');
});
