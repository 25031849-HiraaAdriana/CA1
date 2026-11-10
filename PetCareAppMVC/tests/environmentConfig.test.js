const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { environmentFile, requireSessionSecret } = require('../config/environment');

test('dotenv configuration resolves the project-local .env independently of the launch directory', () => {
  assert.equal(environmentFile, path.join(__dirname, '..', '.env'));
});

test('startup requires a non-empty session secret of at least 32 bytes', () => {
  assert.throws(
    () => requireSessionSecret({}),
    /SESSION_SECRET to a random value of at least 32 bytes/
  );
  assert.throws(
    () => requireSessionSecret({ SESSION_SECRET: 'x'.repeat(31) }),
    /SESSION_SECRET to a random value of at least 32 bytes/
  );
  assert.equal(requireSessionSecret({ SESSION_SECRET: 'x'.repeat(32) }), 'x'.repeat(32));
});

test('database configuration requires an explicit username and password setting', () => {
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === './environment') return { loadEnvironment() {} };
      return load.apply(this, arguments);
    };
    process.env.DB_USER = '';
    assert.throws(() => require('./config/db'), /Set DB_USER/);
    process.env.DB_USER = 'example_user';
    delete process.env.DB_PASSWORD;
    assert.throws(() => require('./config/db'), /Set DB_PASSWORD/);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});

test('database pool and transaction connections share settings and retain promise support', () => {
  const script = `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    let poolConfig;
    let transactionConfig;
    const promiseApi = {};
    Module._load = function(request, parent, isMain) {
      if (request === './environment') return { loadEnvironment() {} };
      if (request === 'mysql2') return {
        createPool(config) { poolConfig = config; return { promise: () => promiseApi }; },
        createConnection(config) { transactionConfig = config; return { promise: () => promiseApi }; }
      };
      return load.apply(this, arguments);
    };
    Object.assign(process.env, {
      DB_HOST: 'example-host', DB_PORT: '3307', DB_USER: 'example-user',
      DB_PASSWORD: '', DB_NAME: 'petcare'
    });
    const db = require('./config/db');
    assert.equal(db.promise(), promiseApi);
    assert.equal(db.createPetShopTransactionConnection().promise(), promiseApi);
    assert.deepEqual(transactionConfig, {
      host: 'example-host', port: 3307, user: 'example-user', password: '', database: 'petcare'
    });
    for (const [key, value] of Object.entries(transactionConfig)) assert.equal(poolConfig[key], value);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});
