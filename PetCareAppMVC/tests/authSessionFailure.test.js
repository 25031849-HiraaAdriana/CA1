const assert = require('node:assert/strict');
const path = require('node:path');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const dbPath = require.resolve('../config/db');
const originalDb = require.cache[dbPath];
const sessions = new Map();
let failRead = false;
let failWrite = false;
const databaseError = Object.assign(new Error('private database details'), {
  code: 'ER_ACCESS_DENIED_ERROR'
});

const connection = {
  promise() {
    return {};
  },
  query(sql, values, callback) {
    setImmediate(() => {
      if (sql.startsWith('SELECT data FROM pomi_sessions')) {
        if (failRead) return callback(databaseError);
        const data = sessions.get(values[0]);
        return callback(null, data ? [{ data }] : []);
      }
      if (sql.startsWith('INSERT INTO pomi_sessions')) {
        if (failWrite) return callback(databaseError);
        sessions.set(values[0], values[2]);
        return callback(null, { affectedRows: 1 });
      }
      if (sql.startsWith('UPDATE pomi_sessions')) return callback(null, { affectedRows: 1 });
      if (sql.startsWith('DELETE FROM pomi_sessions')) {
        sessions.delete(values[0]);
        return callback(null, { affectedRows: 1 });
      }
      if (sql.startsWith('SELECT id, username, name, role')) {
        return callback(Object.assign(new Error('Missing column'), { code: 'ER_BAD_FIELD_ERROR' }));
      }
      return callback(new Error('Unexpected query in session test'));
    });
  }
};

require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: connection, children: [], paths: []
};

const MySQLSessionStore = require('../middleware/mysqlSessionStore');
const sessionErrorHandler = require('../middleware/sessionErrors');
const { csrfToken } = require('../middleware/csrf');
const authRoutes = require('../routes/authRoutes');
const userModel = require('../models/userModel');
let server;
let baseUrl;

before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    name: 'session-test.sid',
    secret: 'session-failure-test-secret-at-least-32-bytes',
    store: new MySQLSessionStore(),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 60000 }
  }));
  app.use(sessionErrorHandler);
  app.use(csrfToken);
  app.use(flash());
  app.use(authRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (originalDb) require.cache[dbPath] = originalDb;
  else delete require.cache[dbPath];
});

test('authentication forms report session save errors before sending a cookie', async () => {
  failWrite = true;
  try {
    for (const route of ['/login', '/signup']) {
      const response = await fetch(baseUrl + route);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('set-cookie'), null);
      const body = await response.text();
      assert.match(body, /Authentication is temporarily unavailable/);
      assert.doesNotMatch(body, /private database details|ER_ACCESS_DENIED_ERROR/);
    }
  } finally {
    failWrite = false;
  }
});

test('saved CSRF session survives requests, and session read errors are sanitized', async () => {
  for (const route of ['/login', '/signup']) {
    const form = await fetch(baseUrl + route);
    assert.equal(form.status, 200);
    const cookie = form.headers.get('set-cookie').split(';', 1)[0];
    const token = (await form.text()).match(/name="_csrf" value="([^"]+)"/)[1];

    const rejected = await fetch(baseUrl + route, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
      redirect: 'manual'
    });
    assert.equal(rejected.status, 403);

    const accepted = await fetch(baseUrl + route, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: token }),
      redirect: 'manual'
    });
    assert.equal(accepted.status, 302);
    assert.equal(accepted.headers.get('location'), route);

    failRead = true;
    try {
      const unavailable = await fetch(baseUrl + route, { headers: { Cookie: cookie } });
      assert.equal(unavailable.status, 503);
      const body = await unavailable.text();
      assert.match(body, /session service is temporarily unavailable/);
      assert.doesNotMatch(body, /private database details|ER_ACCESS_DENIED_ERROR/);
    } finally {
      failRead = false;
    }
  }
});

test('credential lookups propagate database errors', async () => {
  const error = await new Promise(resolve => userModel.findByCredentials('test-user', 'test-hash', resolve));
  assert.equal(error.code, 'ER_BAD_FIELD_ERROR');
});
