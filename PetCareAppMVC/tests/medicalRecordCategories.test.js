const assert = require('node:assert/strict');
const { after, test } = require('node:test');

const connectionPath = require.resolve('../config/db');
const modelPath = require.resolve('../models/medicalRecordModel');
const originalConnection = require.cache[connectionPath];
const originalModel = require.cache[modelPath];
const queries = [];
const allCategories = [
  { category_code: 'x_rays_imaging', category_name: 'X-rays & Imaging' },
  { category_code: 'test_results', category_name: 'Test Results' },
  { category_code: 'medical_history', category_name: 'Medical History' },
  { category_code: 'lab_reports', category_name: 'Lab Reports' },
  { category_code: 'immunisation_records', category_name: 'Immunisation Records' },
  { category_code: 'medication_history', category_name: 'Medication History' }
];
const database = {
  async query(sql) {
    queries.push(sql);
    if (sql.includes('FROM medical_record_categories')) {
      return [[...allCategories.filter(category =>
        !sql.includes("category_code <> 'lab_reports'") ||
        category.category_code !== 'lab_reports'
      )]];
    }
    return [[]];
  }
};

require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: { promise: () => database },
  children: [],
  paths: []
};
delete require.cache[modelPath];
const model = require('../models/medicalRecordModel');

test('active medical-record categories contain exactly five categories without deleting the stored category', async () => {
  const activeCategories = await model.getCategories();
  assert.equal(allCategories.length, 6);
  assert.equal(activeCategories.length, 5);
  assert.equal(activeCategories.find(category => category.category_code === 'x_rays_imaging').category_name,
    'Radiology Results (X-ray, CT, MRI)');
  assert.ok(activeCategories.some(category => category.category_code === 'test_results'));
  assert.ok(!activeCategories.some(category => category.category_code === 'lab_reports'));
  assert.match(queries[0], /category_code <> 'lab_reports'/);
});

test('published, draft and original-document lookups exclude historical Lab Reports records', async () => {
  await model.getPublishedRecordsForOwnerPet(1, 7);
  await model.getPublishedRecordForOwnerPet(1, '1', 7);
  await model.getPublishedRecordDocumentForOwnerPet(1, '1', 7);
  await model.getDraftRecords();
  await model.getDraftRecordById('1');
  await model.getRecordDocumentById('1');

  const retiredRecordQueries = queries.slice(1);
  assert.equal(retiredRecordQueries.length, 6);
  for (const sql of retiredRecordQueries) {
    assert.match(sql, /category_code <> 'lab_reports'/);
  }
});

after(() => {
  if (originalConnection) require.cache[connectionPath] = originalConnection;
  else delete require.cache[connectionPath];
  if (originalModel) require.cache[modelPath] = originalModel;
  else delete require.cache[modelPath];
});
