const assert = require('node:assert/strict');
const { test } = require('node:test');

const queries = [];
const connectionPath = require.resolve('../config/db');
const modelPath = require.resolve('../models/adminActivityModel');
const originalConnectionModule = require.cache[connectionPath];
const originalModelModule = require.cache[modelPath];

require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: {
    promise: () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.startsWith('SHOW TABLES LIKE')) return [[{ table: 'admin_activity_logs' }]];
        if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 1 }]];
        return [[{ id: 8, admin_username: 'MockAdmin' }]];
      }
    })
  },
  children: [],
  paths: []
};
delete require.cache[modelPath];
const adminActivityModel = require('../models/adminActivityModel');

test('activity model filters by audit username and orders newest first', async () => {
  const result = await adminActivityModel.getAdminActivityLogs(
    { adminUsername: 'MockAdmin', adminId: 99 },
    { limit: 20, offset: 0 }
  );

  assert.equal(result.total, 1);
  assert.equal(result.items[0].admin_username, 'MockAdmin');
  assert.match(queries[1].sql, /WHERE al\.admin_username LIKE \?/);
  assert.deepEqual(queries[1].params, ['%MockAdmin%']);
  assert.match(queries[2].sql, /WHERE al\.admin_username LIKE \?/);
  assert.match(queries[2].sql, /ORDER BY al\.created_at DESC, al\.id DESC/);
  assert.deepEqual(queries[2].params, ['%MockAdmin%', 20, 0]);
  assert.doesNotMatch(queries[1].sql, /admin_id =/);

  queries.length = 0;
  await adminActivityModel.getAdminActivityLogs(
    { adminUsername: '', adminName: 'ignored' },
    { limit: 20, offset: 0 }
  );
  assert.doesNotMatch(queries[1].sql, /WHERE/);
  assert.doesNotMatch(queries[2].sql, /WHERE/);
  assert.match(queries[2].sql, /ORDER BY al\.created_at DESC, al\.id DESC/);
  assert.deepEqual(queries[2].params, [20, 0]);
});

test.after(() => {
  if (originalConnectionModule) {
    require.cache[connectionPath] = originalConnectionModule;
  } else {
    delete require.cache[connectionPath];
  }
  if (originalModelModule) {
    require.cache[modelPath] = originalModelModule;
  } else {
    delete require.cache[modelPath];
  }
});
