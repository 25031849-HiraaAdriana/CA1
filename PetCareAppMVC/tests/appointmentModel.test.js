const assert = require('node:assert/strict');
const { test } = require('node:test');
const connectionPath = require.resolve('../config/db');
const modelPath = require.resolve('../models/appointmentModel');
const calls = [];
let result = { affectedRows: 1 };
require.cache[connectionPath] = {
  id: connectionPath, filename: connectionPath, loaded: true, children: [], paths: [],
  exports: { promise: () => ({ query: async (sql, params) => { calls.push({ sql, params }); return [result]; } }) }
};
const model = require('../models/appointmentModel');

test('rescheduling and cancellation enforce ownership and only update allowed fields', async () => {
  const actor = { id: 7, name: 'Owner' };
  await model.reschedule('5', { date: '2099-01-01', time: '10:00' }, actor, 7);
  assert.match(calls.at(-1).sql, /a\.status = 'scheduled' AND p\.owner_id = \?/);
  assert.doesNotMatch(calls.at(-1).sql, /clinic_name|notes|pet_id =|appointment_type/);
  assert.deepEqual(calls.at(-1).params, ['2099-01-01', '10:00', 7, 'Owner', '5', 7]);
  await model.cancel('5', actor, 7);
  assert.match(calls.at(-1).sql, /a\.status = 'scheduled' AND p\.owner_id = \?/);
});

test('administrator creation and editing bind selected pet to selected owner', async () => {
  const data = { ownerId: '7', petId: '4', clinicName: 'Clinic', type: 'Other', date: '2099-01-01', time: '10:00', notes: null };
  const actor = { id: 1, name: 'Admin' };
  await model.create(data, actor);
  assert.match(calls.at(-1).sql, /p\.id = \? AND p\.owner_id = \?/);
  assert.deepEqual(calls.at(-1).params.slice(-2), ['4', '7']);
  await model.update('5', data, actor);
  assert.match(calls.at(-1).sql, /selected_pet\.owner_id = \?/);
  assert.deepEqual(calls.at(-1).params.slice(-2), ['5', '7']);
});

test('dashboard selects the nearest scheduled appointment for the owner', async () => {
  result = [];
  await model.nextForOwner(7, { date: '2026-11-08', time: '14:30:00' });
  const call = calls.at(-1);
  assert.match(call.sql, /p\.owner_id = \? AND p\.status = 'active' AND a\.status = 'scheduled'/);
  assert.match(call.sql, /ORDER BY a\.appointment_date, a\.appointment_time, a\.id LIMIT 1/);
  assert.deepEqual(call.params, [7, '2026-11-08', '2026-11-08', '14:30:00']);
});

test('admin search and filters use bound parameters and page-size limits', async () => {
  result = Array.from({ length: 11 }, (_, i) => ({ id: i }));
  const now = { date: '2026-11-08', time: '14:30:00' };
  for (const filter of ['all', 'upcoming', 'past', 'cancelled']) {
    const page = await model.listAdmin({ search: "x'_%", filter, page: 2, now });
    const call = calls.at(-1);
    assert.equal(page.appointments.length, 10);
    assert.equal(page.hasNext, true);
    assert.match(call.sql, /LIMIT \? OFFSET \?/);
    assert.doesNotMatch(call.sql, /x'_%/);
    assert.deepEqual(call.params.slice(-2), [11, 10]);
    assert.equal((call.sql.match(/\?/g) || []).length, call.params.length);
  }
});

test('admin pet lookup is limited to the selected owner', async () => {
  result = [];
  await model.getPets('7');
  assert.match(calls.at(-1).sql, /p\.owner_id = \?/);
  assert.match(calls.at(-1).sql, /p\.status = 'active'/);
  assert.deepEqual(calls.at(-1).params, ['7']);
});
