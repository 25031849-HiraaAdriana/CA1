const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const { sha256Hash } = require('../helpers/hash');
const { isAdmin, isPetOwner } = require('../middleware/auth');

const userModelPath = require.resolve('../models/userModel');
const originalUserModel = require.cache[userModelPath];
const accounts = [
  { id: 1, username: 'owner', name: 'Owner', role: 'user', password: sha256Hash('owner-password') },
  { id: 2, username: 'admin', name: 'Admin', role: 'admin', password: sha256Hash('admin-password') },
  { id: 3, username: 'legacy', name: 'Legacy', role: 'user', password: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }
];
require.cache[userModelPath] = {
  id: userModelPath, filename: userModelPath, loaded: true, children: [], paths: [],
  exports: {
    findByCredentials(username, password, callback) {
      callback(null, accounts.filter(account => account.username === username && account.password === password));
    },
    createUser(username, password, name, role, callback) {
      if (accounts.some(account => account.username.toLowerCase() === username.toLowerCase())) {
        return callback(Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' }));
      }
      accounts.push({ id: accounts.length + 1, username, password, name, role });
      return callback(null, { insertId: accounts.length });
    }
  }
};

const authRoutes = require('../routes/authRoutes');
let server;
let baseUrl;

before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    name: 'pomi.sid',
    secret: 'password-auth-test-session-secret-32-bytes',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 60000 }
  }));
  app.use(require('../middleware/sessionErrors'));
  app.use(require('../middleware/csrf').csrfToken);
  app.use(flash());
  app.use(authRoutes);
  app.get('/dashboard', isPetOwner, (req, res) => res.send('user dashboard'));
  app.get('/admin/dashboard', isAdmin, (req, res) => res.send('admin dashboard'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (originalUserModel) require.cache[userModelPath] = originalUserModel;
  else delete require.cache[userModelPath];
});

async function get(route, cookie) {
  const response = await fetch(baseUrl + route, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual'
  });
  return {
    response,
    html: await response.text(),
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0] || cookie
  };
}

async function post(route, cookie, fields) {
  const response = await fetch(baseUrl + route, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual'
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] || cookie };
}

function token(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF field should be present');
  return match[1];
}

test('signup validates fields, uses User role and preserves duplicate usernames', async () => {
  const form = await get('/signup');
  assert.equal(form.response.status, 200);
  assert.match(form.html, /Create your account/);
  const csrf = token(form.html);
  const invalid = await post('/signup', form.cookie, { _csrf: csrf, username: '', password: '', name: '' });
  assert.equal(invalid.response.headers.get('location'), '/signup');
  assert.equal(accounts.length, 3);
  for (const fields of [
    { username: 'a'.repeat(50) + ' ', password: 'test', name: 'Owner' },
    { username: 'new', password: 'test', name: 'a'.repeat(100) + ' ' }
  ]) {
    const oversized = await post('/signup', form.cookie, { _csrf: csrf, ...fields });
    assert.equal(oversized.response.headers.get('location'), '/signup');
    assert.equal(accounts.length, 3);
  }
  const duplicate = await post('/signup', form.cookie, {
    _csrf: csrf, username: 'OWNER', password: 'anything', name: 'Duplicate'
  });
  assert.equal(duplicate.response.headers.get('location'), '/signup');
  assert.equal(accounts.length, 3);
  assert.match((await get('/signup', form.cookie)).html, /Username already exists/);
  const created = await post('/signup', form.cookie, {
    _csrf: csrf, username: 'new-owner', password: 'new-password', name: 'New Owner', role: 'admin'
  });
  assert.equal(created.response.headers.get('location'), '/login');
  assert.equal(accounts[3].role, 'user');
  assert.equal(accounts[3].password, sha256Hash('new-password'));
  const loginForm = await get('/login', created.cookie);
  const signedIn = await post('/login', loginForm.cookie, {
    _csrf: token(loginForm.html), username: 'new-owner', password: 'new-password'
  });
  assert.equal(signedIn.response.headers.get('location'), '/dashboard');
  assert.equal((await get('/dashboard', signedIn.cookie)).response.status, 200);
});

test('User and Admin share password login, rotate and persist sessions, and logout', async () => {
  for (const [username, password, dashboard, other] of [
    ['owner', 'owner-password', '/dashboard', '/admin/dashboard'],
    ['legacy', 'abc', '/dashboard', '/admin/dashboard'],
    ['admin', 'admin-password', '/admin/dashboard', '/dashboard']
  ]) {
    const form = await get('/login');
    assert.equal(form.response.status, 200);
    assert.match(form.html, /Welcome back/);
    const originalToken = token(form.html);
    const rejected = await post('/login', form.cookie, { username, password });
    assert.equal(rejected.response.status, 403);
    const signedIn = await post('/login', form.cookie, { _csrf: originalToken, username, password });
    assert.equal(signedIn.response.status, 302);
    assert.equal(signedIn.response.headers.get('location'), dashboard);
    assert.notEqual(signedIn.cookie, form.cookie);
    assert.equal((await get(dashboard, signedIn.cookie)).response.status, 200);
    assert.notEqual((await get(other, signedIn.cookie)).response.status, 200);
    assert.notEqual((await get(dashboard, form.cookie)).response.status, 200);
    const authenticatedForm = await get('/login', signedIn.cookie);
    const currentToken = token(authenticatedForm.html);
    assert.notEqual(currentToken, originalToken);
    assert.equal((await post('/logout', signedIn.cookie, { _csrf: originalToken })).response.status, 403);
    const logout = await post('/logout', signedIn.cookie, { _csrf: currentToken });
    assert.equal(logout.response.headers.get('location'), '/login');
    assert.notEqual((await get(dashboard, signedIn.cookie)).response.status, 200);
  }
});

test('bad credentials fail and removed authenticator routes are unavailable', async () => {
  const form = await get('/login');
  const login = await post('/login', form.cookie, {
    _csrf: token(form.html), username: 'owner', password: 'incorrect'
  });
  assert.equal(login.response.headers.get('location'), '/login');
  assert.match((await get('/login', form.cookie)).html, /Invalid username or password/);
  for (const route of ['/admin/login', '/admin/setup', '/login/2fa', '/account/security', '/admin/accounts']) {
    assert.equal((await get(route)).response.status, 404);
  }
});
