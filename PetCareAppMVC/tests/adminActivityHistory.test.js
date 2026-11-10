const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const ejs = require('ejs');

const activities = [
  {
    id: 4,
    admin_username: 'mock-admin',
    action_type: 'MEDICAL_RECORD_PUBLISHED',
    action_result: 'success',
    admin_name: 'Mock Admin',
    pet_name: 'Milo newest',
    medical_record_id: 102,
    created_at: new Date('2026-10-12T13:00:00Z'),
    metadata: '{invalid JSON'
  },
  {
    id: 3,
    admin_username: 'mock-admin',
    action_type: 'MEDICAL_RECORD_UPLOADED',
    action_result: 'success',
    admin_name: 'Mock Admin',
    pet_name: 'Milo midday',
    medical_record_id: 102,
    created_at: new Date('2026-10-12T12:00:00Z'),
    metadata: null
  },
  {
    id: 2,
    admin_username: 'mock-admin',
    action_type: 'MEDICAL_RECORD_PUBLISHED',
    action_result: 'success',
    admin_name: 'Mock Admin',
    pet_name: 'Milo middle',
    medical_record_id: 101,
    created_at: new Date('2026-10-12T11:00:00Z'),
    metadata: JSON.stringify({ summary: 'Medical record signed and published' })
  },
  {
    id: 1,
    admin_username: 'mock-admin',
    action_type: 'MEDICAL_RECORD_UPLOADED',
    action_result: 'success',
    admin_name: 'Mock Admin',
    pet_name: 'Milo oldest',
    medical_record_id: 101,
    created_at: new Date('2026-10-12T10:00:00Z'),
    metadata: { summary: 'Draft medical record uploaded' }
  }
];

const modelCalls = [];
let activityResult = activities;
const adminActivityModel = {
  isFeatureReady: async () => true,
  getAdminActivityLogs: async (filters, pagination) => {
    modelCalls.push({ filters, pagination });
    return { items: activityResult, total: activityResult.length ? 41 : 0 };
  }
};
const modelPath = require.resolve('../models/adminActivityModel');
require.cache[modelPath] = {
  id: modelPath,
  filename: modelPath,
  loaded: true,
  exports: adminActivityModel,
  children: [],
  paths: []
};

const { listActivityHistory } = require('../controllers/adminActivityController');

test('activity history renders uploaded and published records for all metadata formats', async () => {
  let html;
  const req = {
    query: {
      page: '2',
      admin_username: ' mock-admin '
    },
    session: {
      user: { id: 7, name: 'Mock Admin', role: 'admin' }
    },
    flash: () => []
  };
  const res = {
    render(view, locals) {
      assert.equal(view, 'adminActivityHistory');
      return ejs.renderFile(
        path.join(__dirname, '..', 'views', `${view}.ejs`),
        locals
      ).then(rendered => {
        html = rendered;
        return rendered;
      });
    }
  };

  await listActivityHistory(req, res);

  assert.match(html, /Draft medical record uploaded/);
  assert.match(html, /Medical record signed and published/);
  assert.equal((html.match(/No further detail/g) || []).length, 2);
  assert.match(html, /Medical Record Published/);
  assert.equal((html.match(/<input\b/g) || []).length, 2);
  assert.match(html, /Search by Admin Username/);
  assert.match(html, /Clear Search/);
  assert.doesNotMatch(html, /Admin ID|Admin name|Action type|Date range|Pet name|Medical record ID|Action result/);
  assert.match(html, /page=3&amp;admin_username=mock-admin/);
  assert.ok(
    html.indexOf('Milo newest') < html.indexOf('Milo midday') &&
    html.indexOf('Milo midday') < html.indexOf('Milo middle') &&
    html.indexOf('Milo middle') < html.indexOf('Milo oldest')
  );
  assert.deepEqual(modelCalls[0], {
    filters: { adminUsername: 'mock-admin' },
    pagination: { limit: 20, offset: 20 }
  });

  activityResult = [];
  req.query = {};
  await listActivityHistory(req, res);
  assert.match(html, /No admin activity records were found/);
  assert.deepEqual(modelCalls[1], {
    filters: { adminUsername: '' },
    pagination: { limit: 20, offset: 0 }
  });

  activityResult = [];
  req.query = { admin_username: 'missing-admin' };
  await listActivityHistory(req, res);
  assert.match(html, /No activities found for Admin username “missing-admin”/);
});
