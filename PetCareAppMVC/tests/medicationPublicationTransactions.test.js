const assert = require('node:assert/strict');
const { test } = require('node:test');

const connectionPath = require.resolve('../config/db');
const activityPath = require.resolve('../models/adminActivityModel');
const refillPath = require.resolve('../models/medicationRefillModel');
const originals = new Map([connectionPath, activityPath, refillPath].map(key => [key, require.cache[key]]));
let state;
const { medicalReviewVersion } = require('../helpers/medicalReviewVersion');
const lockedRecord = {
  id: '31', pet_id: 2, storage_key: 'original', document_mime_type: 'application/pdf',
  title: 'Old', category_code: 'medication_history', source_name: 'Clinic'
};

const connection = {
  promise: () => ({
    query: async sql => {
      if (sql.startsWith('SHOW TABLES LIKE')) return [[{ table: 'present' }]];
      throw new Error('Unexpected shared connection query');
    }
  }),
  createPetShopTransactionConnection: () => ({
    promise: () => ({
      connect: async () => state.events.push('connect'),
      beginTransaction: async () => state.events.push('begin'),
      query: async (sql, params) => {
        if (sql.includes('FOR UPDATE')) {
          state.events.push('lock');
          return [state.missing ? [] : [lockedRecord]];
        }
        if (sql.includes('SELECT id, medication_name')) {
          state.events.push('readEntries');
          return [state.oldEntries || []];
        }
        if (sql.startsWith('DELETE FROM medication_entries')) {
          state.events.push('replace');
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('INSERT INTO medication_entries')) {
          state.events.push('entry');
          state.entryParams = params;
          return [{ insertId: 1 }];
        }
        if (sql.includes('UPDATE medical_records')) {
          state.events.push('update');
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('INSERT INTO admin_activity_logs')) {
          state.events.push('audit');
          if (state.fail === 'audit') throw new Error('audit failed');
          return [{ insertId: 41 }];
        }
        if (sql.includes('INSERT INTO medical_record_signatures')) {
          state.events.push('signature');
          state.signatureParams = params;
          if (state.fail === 'signature') throw new Error('signature failed');
          return [{ insertId: 42 }];
        }
        throw new Error('Unexpected transaction query');
      },
      commit: async () => {
        state.events.push('commit');
        if (state.fail === 'commit') throw new Error('commit response lost');
      },
      rollback: async () => {
        state.events.push('rollback');
        if (state.rollbackFails) throw new Error('rollback failed');
      },
      end: async () => {
        state.events.push('end');
        if (state.fail === 'end') throw new Error('close failed');
      }
    })
  })
};

require.cache[connectionPath] = {
  id: connectionPath, filename: connectionPath, loaded: true,
  exports: connection, children: [], paths: []
};
delete require.cache[activityPath];
delete require.cache[refillPath];
const activity = require('../models/adminActivityModel');
const refill = require('../models/medicationRefillModel');

const entries = [{
  medicationName: 'Medicine', dosage: '1 tablet', frequency: 'daily',
  startDate: '2026-10-01', endDate: null
}];
const payload = { recordId: '31', petId: 2, medicationEntries: [{ medicationName: 'stale' }] };
const publication = {
  recordId: '31',
  expectedVersion: medicalReviewVersion(lockedRecord, []),
  adminUser: { id: 7, username: 'admin', name: 'Admin' },
  reviewPayload: payload,
  originalDocument: Buffer.from('original'),
  signatureData: { storageKey: 'key', mimeType: 'image/png', sizeBytes: 20 },
  metadata: { summary: 'Published' },
  recordSnapshot: {
    petId: 2, storageKey: 'original', documentMimeType: 'application/pdf',
    recordTitle: 'Reviewed', categoryCode: 'medication_history', sourceName: 'Clinic',
    recordDate: null, description: null, extractedText: 'Reviewed text', extractionStatus: 'successful'
  },
  medicationEntries: entries
};

function reset(fail = null) { state = { events: [], fail }; }

test('publication writes exactly the signed medication payload on the dedicated transaction', async () => {
  reset();
  assert.deepEqual(await activity.publishMedicalRecord(publication), { auditId: 41, signatureId: 42 });
  assert.deepEqual(state.events, ['connect', 'begin', 'lock', 'readEntries', 'replace', 'entry', 'update', 'audit', 'signature', 'commit', 'end']);
  assert.deepEqual(state.entryParams, ['31', 2, 'Medicine', '1 tablet', 'daily', '2026-10-01', null, 7]);
  assert.equal(state.signatureParams[5], activity.computeReviewVersionHash({ ...payload, medicationEntries: entries }));
});

test('publication failures roll back and uncertain commit never reports rollback', async () => {
  for (const fail of ['audit', 'signature']) {
    reset(fail);
    await assert.rejects(activity.publishMedicalRecord(publication), new RegExp(`${fail} failed`));
    assert.ok(state.events.includes('rollback'));
    assert.ok(!state.events.includes('commit'));
  }
  reset('commit');
  await assert.rejects(activity.publishMedicalRecord(publication), error => error.commitOutcomeUnknown === true);
  assert.ok(!state.events.includes('rollback'));
  reset('audit');
  state.rollbackFails = true;
  await assert.rejects(activity.publishMedicalRecord(publication), error => error.commitOutcomeUnknown === true);
});

test('close failure after commit does not turn a committed publication into a failure', async () => {
  reset('end');
  assert.deepEqual(await activity.publishMedicalRecord(publication), { auditId: 41, signatureId: 42 });
  assert.ok(state.events.includes('commit'));
});

test('stale publication or changed original is rejected before touching entries', async () => {
  reset();
  state.missing = true;
  await assert.rejects(activity.publishMedicalRecord(publication), /no longer a draft/);
  assert.ok(!state.events.includes('replace'));
  reset();
  await assert.rejects(activity.publishMedicalRecord({
    ...publication, recordSnapshot: { ...publication.recordSnapshot, storageKey: 'different' }
  }), /original document or pet changed/);
  assert.ok(!state.events.includes('replace'));
});

test('draft medication edits and audit use the same transaction', async () => {
  reset();
  assert.equal(await refill.saveDraftMedicationReview({
    id: '31', adminId: 7, adminUsername: 'admin', adminName: 'Admin', petName: 'Pet',
    categoryCode: 'medication_history', title: 'Reviewed', sourceName: 'Clinic',
    recordDate: null, description: null, extractedText: 'text', extractionStatus: 'successful',
    entries, expectedVersion: medicalReviewVersion(lockedRecord, [])
  }), true);
  assert.deepEqual(state.events, ['connect', 'begin', 'lock', 'readEntries', 'update', 'replace', 'entry', 'audit', 'commit', 'end']);
});

test('a concurrent draft edit invalidates the form before replacing or publishing entries', async () => {
  reset();
  state.oldEntries = [{ id: 9, medication_name: 'Changed by another admin' }];
  await assert.rejects(activity.publishMedicalRecord(publication), error => error.code === 'STALE_MEDICATION_REVIEW');
  assert.deepEqual(state.events, ['connect', 'begin', 'lock', 'readEntries', 'rollback', 'end']);
});

test('one-page non-medication publication rejects a changed record under the transaction lock', async () => {
  const originalCategory = lockedRecord.category_code;
  lockedRecord.category_code = 'test_results';
  try {
    const nonMedication = {
      ...publication,
      medicationEntries: null,
      enforceRecordVersion: true,
      expectedVersion: medicalReviewVersion(lockedRecord, []),
      recordSnapshot: { ...publication.recordSnapshot, categoryCode: 'test_results' }
    };
    reset();
    await activity.publishMedicalRecord(nonMedication);
    assert.ok(state.events.includes('commit'));
    reset();
    await assert.rejects(activity.publishMedicalRecord({ ...nonMedication, expectedVersion: 'stale' }),
      error => error.code === 'STALE_MEDICATION_REVIEW');
    assert.deepEqual(state.events, ['connect', 'begin', 'lock', 'rollback', 'end']);
  } finally {
    lockedRecord.category_code = originalCategory;
  }
});

test('model rejects medication publication without signature or reviewed entries', async () => {
  for (const change of [{ signatureData: null }, { medicationEntries: null }]) {
    reset();
    await assert.rejects(activity.publishMedicalRecord({ ...publication, ...change }),
      /requires reviewed entries and a signature/);
    assert.ok(!state.events.includes('replace'));
    assert.ok(state.events.includes('rollback'));
  }
});

test.after(() => {
  for (const [key, module] of originals) {
    if (module) require.cache[key] = module;
    else delete require.cache[key];
  }
});
