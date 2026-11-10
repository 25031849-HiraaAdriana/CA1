const assert = require('node:assert/strict');
const { test } = require('node:test');

const connectionPath = require.resolve('../config/db');
const modelPath = require.resolve('../models/medicationRefillModel');
const originalConnection = require.cache[connectionPath];
const originalModel = require.cache[modelPath];
let scenario;

const fakeConnection = {
  promise: () => ({
    query: async (sql, params) => {
      if (sql.startsWith('SHOW TABLES LIKE')) return [[{ table: params[0] }]];
      scenario.reads.push({ sql, params });
      if (sql.includes('WHERE request_key = ?')) return [scenario.duplicateRow ? [scenario.duplicateRow] : []];
      if (sql.includes('SELECT id FROM medication_refill_requests')) return [scenario.activeRow ? [scenario.activeRow] : []];
      return [[]];
    }
  }),
  createPetShopTransactionConnection: () => ({
    promise: () => ({
      connect: async () => { scenario.events.push('connect'); },
      beginTransaction: async () => { scenario.events.push('begin'); },
      query: async (sql, params) => {
        if (sql.includes('WHERE request_key = ?')) {
          scenario.events.push('key');
          return [scenario.initialRow ? [scenario.initialRow] : []];
        }
        if (sql.includes('INSERT INTO medication_refill_requests')) {
          scenario.events.push('insert');
          scenario.insert = { sql, params };
          if (scenario.duplicateError) {
            const error = new Error('Duplicate');
            error.code = 'ER_DUP_ENTRY';
            throw error;
          }
          return [{ affectedRows: 1, insertId: 20 }];
        }
        if (sql.includes('FOR UPDATE')) {
          scenario.events.push('lock');
          return [scenario.found ? [{
            id: 1, status: 'Pending', owner_id: 7, pet_id: 2,
            medical_record_id: 3, pet_name: 'Pet', record_title: 'Record'
          }] : []];
        }
        if (sql.includes('UPDATE medication_refill_requests')) {
          scenario.events.push('update');
          return [{ affectedRows: scenario.affectedRows === undefined ? 1 : scenario.affectedRows }];
        }
        if (sql.includes('INSERT INTO admin_activity_logs')) {
          scenario.events.push('audit');
          if (scenario.auditFails) throw new Error('injected audit failure');
          return [{ insertId: 10 }];
        }
        throw new Error('Unexpected mocked query');
      },
      commit: async () => { scenario.events.push('commit'); },
      rollback: async () => { scenario.events.push('rollback'); },
      end: async () => { scenario.events.push('end'); }
    })
  })
};

require.cache[connectionPath] = {
  id: connectionPath, filename: connectionPath, loaded: true,
  exports: fakeConnection, children: [], paths: []
};
delete require.cache[modelPath];
const model = require('../models/medicationRefillModel');

function reset(options = {}) {
  scenario = { events: [], reads: [], found: true, auditFails: false, ...options };
}

const review = {
  requestId: '1', status: 'Ready for Test Payment', demoPriceCents: 1234,
  reviewNote: 'Demo review', adminId: 1, adminUsername: 'admin', adminName: 'Admin'
};

test('mocked admin review commits update and audit together', async () => {
  reset();
  assert.equal(await model.updateAdminRefillRequest(review), true);
  assert.deepEqual(scenario.events, ['connect', 'begin', 'lock', 'update', 'audit', 'commit', 'end']);
});

test('mocked audit failure rolls back the request update', async () => {
  reset({ auditFails: true });
  await assert.rejects(model.updateAdminRefillRequest(review), /injected audit failure/);
  assert.deepEqual(scenario.events, ['connect', 'begin', 'lock', 'update', 'audit', 'rollback', 'end']);
});

test('mocked stale or ineligible review makes no update or audit entry', async () => {
  reset({ found: false });
  assert.equal(await model.updateAdminRefillRequest(review), false);
  assert.deepEqual(scenario.events, ['connect', 'begin', 'lock', 'commit', 'end']);
});

test('owner medication lookup requests only published medication history for the same pet', async () => {
  reset();
  await model.getMedicationEntryForOwnerPet('11', 2, 7);
  const { sql, params } = scenario.reads[0];
  assert.match(sql, /p\.id = mr\.pet_id AND p\.id = me\.pet_id/);
  assert.match(sql, /p\.id = \? AND p\.owner_id = \?/);
  assert.match(sql, /mr\.publication_status = 'published'/);
  assert.match(sql, /mr\.category_code = 'medication_history'/);
  assert.deepEqual(params, ['11', 2, 7]);
});

test('both owner active-request queries exclude both terminal statuses', async () => {
  reset();
  await model.getPublishedMedicationEntriesForOwnerPet(2, 7);
  await model.getActiveRefillRequest('11', 7);
  assert.equal(scenario.reads.length, 2);
  for (const { sql } of scenario.reads) assert.match(sql, /status NOT IN \('Rejected', 'Paid'\)/);
});

test('CA1 review rejects Paid, invalid prices, and a failed update before auditing', async () => {
  reset();
  await assert.rejects(model.updateAdminRefillRequest({ ...review, status: 'Paid' }), /Invalid CA1/);
  await assert.rejects(model.updateAdminRefillRequest({ ...review, demoPriceCents: 0 }), /Invalid CA1/);
  assert.deepEqual(scenario.events, []);
  reset({ affectedRows: 0 });
  await assert.rejects(model.updateAdminRefillRequest(review), /update failed/);
  assert.deepEqual(scenario.events, ['connect', 'begin', 'lock', 'update', 'rollback', 'end']);
});

const request = { requestKey: 'key', ownerId: 7, petId: 2, recordId: '3', medicationEntryId: '11', reason: 'Running Low', quantity: 2, unit: 'tablets' };
const existing = { id: 21, owner_id: 7, pet_id: 2, medication_entry_id: '11' };

test('duplicate request-key races return the existing request only when identities match', async () => {
  reset({ duplicateError: true, duplicateRow: existing });
  assert.deepEqual(await model.createOwnerRefillRequest(request), { id: 21, duplicateSubmission: true });
  assert.deepEqual(scenario.events, ['connect', 'begin', 'key', 'insert', 'rollback', 'end']);
  reset({ duplicateError: true, duplicateRow: { ...existing, owner_id: 8 } });
  await assert.rejects(model.createOwnerRefillRequest(request), error => error.code === 'INVALID_REQUEST_KEY');
  reset({ initialRow: existing });
  assert.deepEqual(await model.createOwnerRefillRequest(request), { id: 21, duplicateSubmission: true });
});

test('duplicate active requests are distinguished from unrelated unique violations', async () => {
  reset({ duplicateError: true, activeRow: { id: 22 } });
  await assert.rejects(model.createOwnerRefillRequest(request), error => error.code === 'ACTIVE_REQUEST_EXISTS');
  reset({ duplicateError: true });
  await assert.rejects(model.createOwnerRefillRequest(request), error => error.code === 'ER_DUP_ENTRY');
});

test('insert binds reason and quantity and rechecks owner, record, publication and unit', async () => {
  reset();
  assert.deepEqual(await model.createOwnerRefillRequest(request), { id: 20, duplicateSubmission: false });
  assert.deepEqual(scenario.insert.params, ['key', 'Running Low', 2, 'tablets', '11', '3', 2, 7, 'tablets', 'tablets']);
  assert.match(scenario.insert.sql, /mr\.id = \? AND p\.id = \? AND p\.owner_id = \?/);
  assert.match(scenario.insert.sql, /mr\.publication_status = 'published'/);
  assert.match(scenario.insert.sql, /BINARY TRIM\(me\.refill_quantity_unit\) = BINARY \?/);
});

test.after(() => {
  if (originalConnection) require.cache[connectionPath] = originalConnection;
  else delete require.cache[connectionPath];
  if (originalModel) require.cache[modelPath] = originalModel;
  else delete require.cache[modelPath];
});
