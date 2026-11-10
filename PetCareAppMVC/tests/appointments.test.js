const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { before, after, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const pets = [
  { id: 1, name: 'Milo', owner_id: 7, owner_name: 'Owner', microchip_id: 'CHIP1', avs_licence_number: 'AVS1', status: 'active' },
  { id: 2, name: 'Luna', owner_id: 8, owner_name: 'Other', microchip_id: 'CHIP2', status: 'active' }
];
const appointments = [];
function mock(module, exports) {
  const resolved = require.resolve(module);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, children: [], paths: [], exports };
}
const allowed = (pet, ownerId) => pet && (ownerId === null || String(pet.owner_id) === String(ownerId));
const model = {
  getPets: async ownerId => pets.filter(p => allowed(p, ownerId)),
  getOwner: async ownerId => {
    const pet = pets.find(p => String(p.owner_id) === String(ownerId));
    return pet ? { id: pet.owner_id, name: pet.owner_name } : null;
  },
  searchOwners: async search => pets.filter(p => p.owner_name.toLowerCase().includes(search.toLowerCase()))
    .map(p => ({ id: p.owner_id, name: p.owner_name })),
  list: async ownerId => appointments.filter(a => allowed(pets.find(p => p.id === a.pet_id), ownerId))
    .sort((a, b) => `${a.appointment_date} ${a.appointment_time}`.localeCompare(`${b.appointment_date} ${b.appointment_time}`)),
  find: async (id, ownerId) => (await model.list(ownerId)).find(a => String(a.id) === id) || null,
  listAdmin: async ({ search, filter, page, now }) => {
    const items = (await model.list(null)).map(a => ({
      ...a, display_status: a.status === 'cancelled' ? 'Cancelled'
        : `${a.appointment_date} ${a.appointment_time}:00` >= `${now.date} ${now.time}` ? 'Upcoming' : 'Past'
    })).filter(a => (!search || [a.owner_name, a.pet_name, a.clinic_name].some(value => value.toLowerCase().includes(search.toLowerCase()))) &&
      (filter === 'all' || a.display_status.toLowerCase() === filter))
      .sort((a, b) => {
        const order = { Upcoming: 0, Past: 1, Cancelled: 2 };
        const status = order[a.display_status] - order[b.display_status];
        const dates = `${a.appointment_date} ${a.appointment_time}`.localeCompare(`${b.appointment_date} ${b.appointment_time}`);
        return status || (a.display_status === 'Upcoming' ? dates : -dates) || b.id - a.id;
      });
    const selected = items.slice((page - 1) * 10, page * 10 + 1);
    return { appointments: selected.slice(0, 10), hasNext: selected.length > 10 };
  },
  nextForOwner: async (ownerId, now) => (await model.list(ownerId))
    .find(a => a.status === 'scheduled' && `${a.appointment_date} ${a.appointment_time}:00` >= `${now.date} ${now.time}`) || null,
  create: async (data, actor) => {
    const pet = pets.find(p => String(p.id) === data.petId);
    if (!pet || String(pet.owner_id) !== data.ownerId) return false;
    appointments.push({
      id: appointments.length + 1, pet_id: pet.id, pet_name: pet.name, pet_status: pet.status,
      owner_id: pet.owner_id, owner_name: pet.owner_name,
      clinic_name: data.clinicName, appointment_type: data.type, appointment_date: data.date,
      appointment_time: data.time, notes: data.notes, status: 'scheduled', creator_name: actor.name, updater_name: actor.name
    });
    return true;
  },
  update: async (id, data, actor) => {
    const appointment = await model.find(id, null);
    const pet = pets.find(p => String(p.id) === data.petId);
    if (!appointment || appointment.status !== 'scheduled' || !pet || String(pet.owner_id) !== data.ownerId) return false;
    Object.assign(appointment, { pet_id: pet.id, pet_name: pet.name, owner_id: pet.owner_id, owner_name: pet.owner_name,
      pet_status: pet.status, clinic_name: data.clinicName, appointment_type: data.type, appointment_date: data.date,
      appointment_time: data.time, notes: data.notes, updater_name: actor.name });
    return true;
  },
  reschedule: async (id, data, actor, ownerId) => {
    const appointment = await model.find(id, ownerId);
    if (!appointment || appointment.status !== 'scheduled') return false;
    Object.assign(appointment, { appointment_date: data.date, appointment_time: data.time, updater_name: actor.name });
    return true;
  },
  cancel: async (id, actor, ownerId) => {
    const appointment = await model.find(id, ownerId);
    if (!appointment || appointment.status !== 'scheduled') return false;
    appointment.status = 'cancelled';
    appointment.updater_name = actor.name;
    return true;
  }
};
mock('../models/appointmentModel', model);
mock('../models/petModel', { getPetsByOwner: (id, cb) => cb(null, pets.filter(p => p.owner_id === id)) });
mock('../models/petShopModel', { isFeatureReady: async () => false });
mock('../models/medicationRefillModel', { isFeatureReady: async () => false });

let server;
let base;
before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'offline-appointment-tests', resave: false, saveUninitialized: false }));
  app.use(flash());
  app.get('/test-login/:role/:id', (req, res) => {
    req.session.user = { id: Number(req.params.id), role: req.params.role, name: req.params.role + req.params.id };    req.session.csrfToken = `token-${req.params.id}`;
    res.sendStatus(204);
  });
  app.use(require('../routes/appointmentRoutes'));
  app.use(require('../routes/indexRoutes'));
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
  const response = await fetch(base + url, { redirect: 'manual', headers: { Cookie: cookie } });
  return { response, html: await response.text() };
}
async function post(url, cookie, fields) {
  return fetch(base + url, { method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
}

test('appointment form renders role-specific back links without a returnTo local', async () => {
  for (const [isAdmin, back, appointmentId] of [
    [true, '/admin/appointments', null], [false, '/dashboard', '1']
  ]) {
    const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'appointmentForm.ejs'), {
      session: { user: { name: 'Tester', role: isAdmin ? 'admin' : 'user' } },
      base: isAdmin ? '/admin/appointments' : '/appointments',
      isAdmin, csrfToken: 'token', appointmentId,
      pets: [{ id: 1, name: 'Milo', owner_name: 'Owner' }],
      types: ['Checkup'], errorMessage: null, ownerSearch: '', owners: [],
      selectedOwner: isAdmin ? { id: 7, name: 'Owner' } : null,
      appointment: isAdmin ? null : { pet_name: 'Milo', clinic_name: 'Clinic', appointment_type: 'Checkup' },
      values: { owner_id: '7', pet_id: '1', clinic_name: 'Clinic', appointment_type: 'Checkup',
        appointment_date: '2099-12-01', appointment_time: '10:30', notes: '' }
    });
    assert.ok(html.includes(`href="${back}">`));
    if (!isAdmin) assert.doesNotMatch(html, />Add appointment</);
  }
});

test('only admins create appointments; owners can edit and cancel their own', async () => {
  const owner = await login('user', 7);
  const other = await login('user', 8);
  const admin = await login('admin', 1);
  const form = { _csrf: 'token-7', owner_id: '7', pet_id: '1', clinic_name: 'Clinic A', appointment_type: 'Checkup',
    appointment_date: '2099-12-01', appointment_time: '10:30', notes: 'Bring records' };
  let page = await get('/appointments/new', owner);
  assert.equal(page.response.status, 403);
  assert.equal((await post('/appointments', owner, form)).status, 403);
  assert.equal((await post('/appointments', owner, { ...form, _csrf: '' })).status, 403);
  assert.equal(appointments.length, 0);
  page = await get('/admin/appointments/new?owner_search=Owner', admin);
  assert.equal(page.response.status, 200);
  assert.match(page.html, /Owner/);
  assert.doesNotMatch(page.html, /Luna/);
  page = await get('/admin/appointments/new?owner_id=7', admin);
  assert.match(page.html, /Milo/);
  assert.match(page.html, /CHIP1/);
  assert.doesNotMatch(page.html, /Luna|CHIP2/);
  assert.match(page.html, /does not book/);
  assert.match(page.html, /href="\/admin\/appointments">← Back to appointments/);
  assert.doesNotMatch(page.html, /href="\/appointments">/);
  assert.equal((await post('/admin/appointments', admin, { ...form, _csrf: '' })).status, 403);
  assert.equal((await post('/admin/appointments', admin, { ...form, _csrf: 'token-1', pet_id: '999' })).status, 404);
  assert.equal((await post('/admin/appointments', admin, { ...form, _csrf: 'token-1', pet_id: '2' })).status, 404);
  for (const invalid of [{ appointment_date: '2025-02-29' }, { appointment_time: '25:01' },
    { appointment_type: 'Invalid' }, { clinic_name: '  ' }, { notes: 'x'.repeat(1001) }]) {
    const invalidResponse = await post('/admin/appointments', admin, { ...form, ...invalid, _csrf: 'token-1' });
    assert.equal(invalidResponse.status, 400);
    assert.match(await invalidResponse.text(), /href="\/admin\/appointments">← Back to appointments/);
  }
  assert.equal(appointments.length, 0);
  let response = await post('/admin/appointments', admin, { ...form, _csrf: 'token-1' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/appointments');
  assert.equal(appointments[0].creator_name, 'admin1');
  assert.equal((await post('/admin/appointments/1', admin, { ...form, _csrf: 'token-1', pet_id: '2' })).status, 404);
  assert.equal(appointments[0].pet_id, 1);
  page = await get('/appointments/1/edit', owner);
  assert.match(page.html, /href="\/dashboard">← Back to dashboard/);
  assert.doesNotMatch(page.html, /Luna/);
  assert.doesNotMatch(page.html, /name="(?:pet_id|clinic_name|appointment_type|notes)"/);
  assert.doesNotMatch(page.html, /CHIP1|CHIP2|AVS1/);
  assert.equal((await post('/appointments/1/cancel', owner, { _csrf: '' })).status, 403);
  assert.equal(appointments[0].status, 'scheduled');
  const removedList = await get('/appointments', other);
  assert.equal(removedList.response.status, 302);
  assert.equal(removedList.response.headers.get('location'), '/dashboard');
  assert.equal((await get('/appointments/1/edit', other)).response.status, 404);
  assert.equal((await post('/appointments/1', other, { ...form, _csrf: 'token-8' })).status, 404);
  assert.equal((await post('/appointments/1', owner, { ...form, pet_id: '2' })).status, 302);
  assert.equal(appointments[0].pet_id, 1);
  assert.equal((await post('/appointments/1/cancel', other, { _csrf: 'token-8' })).status, 404);
  assert.equal((await get('/admin/appointments', owner)).response.status, 403);
  response = await post('/appointments/1', owner, {
    ...form, clinic_name: 'Clinic B', appointment_date: '2099-12-02', appointment_time: '14:45'
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/dashboard');
  assert.equal(appointments[0].clinic_name, 'Clinic A');
  assert.equal(appointments[0].appointment_date, '2099-12-02');
  assert.equal(appointments[0].appointment_time, '14:45');
  assert.equal(appointments[0].notes, 'Bring records');
  assert.equal((await post('/admin/appointments/1', admin, { ...form, _csrf: 'token-1', clinic_name: 'Clinic B', notes: '<script>bad</script>' })).status, 302);
  const escapedPage = (await get('/admin/appointments/1/edit', admin)).html;
  assert.match(escapedPage, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(escapedPage, /<script>bad<\/script>/);
  response = await post('/admin/appointments', admin, {
    ...form, _csrf: 'token-1', clinic_name: 'Admin Clinic', appointment_date: '2099-01-01'
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin/appointments');
  page = await get('/dashboard', owner);
  assert.doesNotMatch(page.html, /href="\/appointments">/);
  assert.match(page.html, /Admin Clinic/);
  assert.match(page.html, /Checkup · Milo/);
  assert.match(page.html, /1 Jan 2099, 10:30 AM/);
  assert.match(page.html, /href="\/appointments\/2\/edit">Choose Another Date/);
  assert.match(page.html, /action="\/appointments\/2\/cancel"/);
  assert.doesNotMatch(page.html, /View appointments|Manage appointments/);
  assert.doesNotMatch((await get('/dashboard', other)).html, /Admin Clinic/);
  page = await get('/admin/appointments', admin);
  assert.match(page.html, /href="\/admin\/appointments"/);
  assert.match(page.html, /Admin Clinic/);
  assert.match(page.html, /admin1/);
  page = await get('/admin/appointments/2/edit', admin);
  assert.match(page.html, /href="\/admin\/appointments">← Back to appointments/);
  assert.equal((await post('/admin/appointments/2', admin, {
    ...form, _csrf: 'token-1', clinic_name: 'Admin Updated', appointment_date: '2099-01-01'
  })).status, 302);
  assert.equal(appointments[1].updater_name, 'admin1');
  assert.match((await get('/dashboard', owner)).html, /Admin Updated/);
  assert.equal((await post('/admin/appointments/2/cancel', admin, { _csrf: 'token-1' })).status, 302);
  assert.equal(appointments[1].updater_name, 'admin1');
  assert.match((await get('/dashboard', owner)).html, /Clinic B/);
  response = await post('/appointments/1/cancel', owner, { _csrf: 'token-7' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/dashboard');
  assert.equal((await get('/appointments/1/edit', owner)).response.status, 404);
  assert.match((await get('/admin/appointments', admin)).html, /Cancelled/);
  assert.match((await get('/dashboard', owner)).html, /No upcoming appointments/);
  assert.equal((await post('/admin/appointments', admin, {
    ...form, _csrf: 'token-1', owner_id: '8', pet_id: '2', appointment_date: '2000-01-01'
  })).status, 302);
  assert.match((await get('/admin/appointments', admin)).html, /Past/);
  assert.doesNotMatch((await get('/dashboard', owner)).html, /Luna/);
  const { notes, ...withoutNotes } = form;
  assert.equal((await post('/admin/appointments', admin, { ...withoutNotes, _csrf: 'token-1' })).status, 302);
  assert.equal(appointments.at(-1).notes, null);
});

test('admin search, status filters and pagination retain query and nearest-first ordering', async () => {
  const admin = await login('admin', 1);
  const owner = await login('user', 7);
  for (let i = 0; i < 12; i++) {
    appointments.push({
      id: appointments.length + 1, pet_id: 1, pet_name: 'Milo', owner_id: 7, owner_name: 'Owner',
      clinic_name: `Search clinic ${String(i).padStart(2, '0')}`, appointment_type: 'Checkup',
      appointment_date: `2098-01-${String(i + 1).padStart(2, '0')}`, appointment_time: '10:00',
      status: 'scheduled', creator_name: 'Admin', updater_name: 'Admin', notes: null
    });
  }
  const first = await get('/admin/appointments?search=Search&filter=upcoming', admin);
  assert.equal(first.response.status, 200);
  assert.ok(first.html.indexOf('Search clinic 00') < first.html.indexOf('Search clinic 09'));
  assert.doesNotMatch(first.html, /Search clinic 10/);
  assert.match(first.html, /search=Search&amp;filter=upcoming&amp;page=2/);
  const second = await get('/admin/appointments?search=Search&filter=upcoming&page=2', admin);
  assert.match(second.html, /Search clinic 10/);
  assert.match(second.html, /Search clinic 11/);
  assert.doesNotMatch(second.html, /Search clinic 09/);
  assert.match(second.html, /search=Search&amp;filter=upcoming&amp;page=1/);
  assert.match((await get('/admin/appointments?search=Luna&filter=past', admin)).html, /Luna/);
  assert.match((await get('/admin/appointments?search=Owner&filter=cancelled', admin)).html, /Cancelled/);
  assert.match((await get('/admin/appointments?search=NoMatch&filter=all', admin)).html, /No appointments found/);
  assert.equal((await get('/admin/appointments/new?owner_search=Owner', owner)).response.status, 403);
});
