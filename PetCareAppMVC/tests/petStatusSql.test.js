const assert = require('node:assert/strict');
const { test } = require('node:test');

const sharedCalls = [];
const transactionCalls = [];
const tables = new Set([
  'medication_entries', 'medication_refill_requests', 'admin_activity_logs'
]);
const transactionDatabase = {
  connect: async () => {},
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    transactionCalls.push({ sql, params });
    if (/SELECT id, owner_id, pet_id, medication_entry_id/.test(sql)) return [[]];
    if (/INSERT INTO medication_refill_requests/.test(sql)) return [{ affectedRows: 1, insertId: 99 }];
    return [[]];
  }
};
const database = {
  query: async (sql, params = []) => {
    sharedCalls.push({ sql, params });
    if (/SHOW TABLES LIKE/.test(sql)) return [[tables.has(params[0]) ? { table_name: params[0] } : []].flat()];
    return [[]];
  }
};
const connection = {
  query(sql, params, callback) {
    sharedCalls.push({ sql, params });
    callback(null, []);
  },
  promise: () => database,
  createPetShopTransactionConnection: () => ({ promise: () => transactionDatabase })
};
const connectionPath = require.resolve('../config/db');
require.cache[connectionPath] = {
  id: connectionPath, filename: connectionPath, loaded: true, children: [], paths: [], exports: connection
};

const petModel = require('../models/petModel');
const appointmentModel = require('../models/appointmentModel');
const petShopModel = require('../models/petShopModel');
const medicalRecordModel = require('../models/medicalRecordModel');
const medicationRefillModel = require('../models/medicationRefillModel');
const journalModel = require('../models/journalModel');

test('active pet selection is enforced for dashboard, appointments and Pet Shop suggestions', async () => {
  sharedCalls.length = 0;
  petModel.getPetsByOwner(7, () => {});
  await appointmentModel.getPets(7);
  await appointmentModel.searchOwners('Owner');
  await appointmentModel.create({
    ownerId: '7', petId: '8', clinicName: 'Clinic', type: 'Checkup',
    date: '2099-01-01', time: '10:00', notes: null
  }, { id: 1, name: 'Admin' });
  await petShopModel.getOwnerPets(7);
  await petShopModel.getOwnerPet(7, 8);

  for (const call of sharedCalls.filter(call => /FROM pets|JOIN pets/.test(call.sql))) {
    assert.match(call.sql, /status = 'active'/);
  }
});

test('owner medical record and journal lookup queries exclude inactive pets', async () => {
  sharedCalls.length = 0;
  await medicalRecordModel.getOwnerPetById(8, 7);
  await medicalRecordModel.getPublishedRecordsForOwnerPet(8, 7);
  await medicalRecordModel.getPublishedRecordForOwnerPet(8, 3, 7);
  await medicalRecordModel.getPublishedRecordDocumentForOwnerPet(8, 3, 7);
  journalModel.getJournalsByOwner(7, () => {});

  for (const call of sharedCalls.filter(call => /JOIN pets|FROM pets/.test(call.sql))) {
    assert.match(call.sql, /status = 'active'/);
  }
});

test('new refill requests include an active-pet predicate in the database insert', async () => {
  transactionCalls.length = 0;
  await medicationRefillModel.createOwnerRefillRequest({
    requestKey: '12345678-1234-4123-8123-123456789abc',
    ownerId: 7, petId: 8, recordId: 3, medicationEntryId: 5,
    reason: 'Running Low', quantity: 1, unit: 'tablets'
  });

  const insert = transactionCalls.find(call => /INSERT INTO medication_refill_requests/.test(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /p\.status = 'active'/);
});

test('dashboard refill query selects only the owner’s active pets and quotations awaiting test payment', async () => {
  sharedCalls.length = 0;
  await medicationRefillModel.getOwnerAcceptedDemoRefills(7);
  const query = sharedCalls.find(call => /FROM medication_refill_requests rr/.test(call.sql));
  assert.ok(query);
  assert.match(query.sql, /rr\.owner_id = \?/);
  assert.match(query.sql, /p\.owner_id = rr\.owner_id/);
  assert.match(query.sql, /p\.status = 'active'/);
  assert.match(query.sql, /rr\.status = 'Ready for Test Payment'/);
  assert.deepEqual(query.params, [7]);
});
