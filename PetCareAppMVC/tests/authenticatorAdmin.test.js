const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const { generate, generateSecret, verify: verifyOtp } = require('otplib');
const { sha256Hash } = require('../helpers/hash');

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  POMI_2FA_ENCRYPTION_KEY: process.env.POMI_2FA_ENCRYPTION_KEY,
  POMI_ADMIN_SETUP_TOKEN: process.env.POMI_ADMIN_SETUP_TOKEN
};
process.env.NODE_ENV = 'test';
process.env.POMI_2FA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.POMI_ADMIN_SETUP_TOKEN = crypto.randomBytes(48).toString('hex');

const userModelPath = require.resolve('../models/userModel');
const securityModelPath = require.resolve('../models/authSecurityModel');
const originalUserModel = require.cache[userModelPath];
const originalSecurityModel = require.cache[securityModelPath];
const totp = require('../helpers/totp');
const projectRoot = path.join(__dirname, '..');
const userAccounts = new Map();
let initialSetupComplete = false;
let nextId = 100;

function account({ id, username, role, enabled = false, secret = null }) {
  return {
    id,
    username,
    password: sha256Hash('strong-test-password'),
    name: username,
    role,
    totp_enabled: enabled ? 1 : 0,
    totp_secret_encrypted: secret,
    totp_pending_secret_encrypted: null,
    totp_pending_expires_at: null,
    totp_last_used_step: null,
    totp_failed_attempts: 0,
    totp_locked_until: 0,
    totp_is_locked: false,
    recovery: new Set()
  };
}

const user = account({ id: 7, username: 'owner', role: 'user' });
const userWithTotpSecret = generateSecret();
const protectedUser = account({
  id: 8,
  username: 'protected-owner',
  role: 'user',
  enabled: true,
  secret: totp.encryptSecret(userWithTotpSecret)
});
const admin = account({ id: 9, username: 'administrator', role: 'admin' });
userAccounts.set(user.id, user);
userAccounts.set(protectedUser.id, protectedUser);
userAccounts.set(admin.id, admin);

function copyAccount(record) {
  return {
    ...record,
    totp_is_locked: record.totp_locked_until > Date.now()
  };
}

const fakeUserModel = {
  findByCredentials(username, password, callback) {
    const match = [...userAccounts.values()].find(record =>
      record.username === username && record.password === password
    );
    callback(null, match ? [copyAccount(match)] : []);
  },
  findAdminByCredentials(username, password, callback) {
    const match = [...userAccounts.values()].find(record =>
      record.username === username && record.password === password && record.role === 'admin'
    );
    callback(null, match ? [copyAccount(match)] : []);
  },
  createUser(username, password, name, role, callback) {
    const record = account({ id: nextId++, username, role });
    record.password = password;
    record.name = name;
    userAccounts.set(record.id, record);
    callback(null, { insertId: record.id });
  }
};

const fakeSecurityModel = {
  async findAccountById(id) {
    const record = userAccounts.get(Number(id));
    return record ? copyAccount(record) : null;
  },
  async beginTotpEnrollment(id, encrypted) {
    const record = userAccounts.get(Number(id));
    record.totp_pending_secret_encrypted = encrypted;
    record.totp_pending_expires_at = Date.now() + 10 * 60 * 1000;
  },
  async getPendingTotpSecret(id) {
    const record = userAccounts.get(Number(id));
    return record && record.totp_pending_expires_at > Date.now()
      ? record.totp_pending_secret_encrypted
      : null;
  },
  async consumeTotpFailure(id) {
    const record = userAccounts.get(Number(id));
    if (record.totp_locked_until > Date.now()) return false;
    record.totp_failed_attempts += 1;
    if (record.totp_failed_attempts >= 5) {
      record.totp_locked_until = Date.now() + 15 * 60 * 1000;
    }
    return true;
  },
  async recordValidTotp(id, step) {
    const record = userAccounts.get(Number(id));
    if (record.totp_locked_until > Date.now() ||
        (record.totp_last_used_step !== null && record.totp_last_used_step >= step)) return false;
    record.totp_last_used_step = step;
    record.totp_failed_attempts = 0;
    record.totp_locked_until = 0;
    return true;
  },
  async consumeRecoveryCode(id, verifier) {
    const record = userAccounts.get(Number(id));
    if (!record.recovery.has(verifier)) return false;
    record.recovery.delete(verifier);
    record.totp_failed_attempts = 0;
    record.totp_locked_until = 0;
    return true;
  },
  async activateTotp(id, encrypted, step, verifiers) {
    const record = userAccounts.get(Number(id));
    assert.equal(record.totp_pending_secret_encrypted, encrypted);
    assert.ok(record.totp_pending_expires_at > Date.now());
    record.totp_secret_encrypted = encrypted;
    record.totp_enabled = 1;
    record.totp_pending_secret_encrypted = null;
    record.totp_pending_expires_at = null;
    record.totp_last_used_step = step;
    record.totp_failed_attempts = 0;
    record.totp_locked_until = 0;
    record.recovery = new Set(verifiers);
  },
  async disableTotp(id) {
    const record = userAccounts.get(Number(id));
    record.totp_enabled = 0;
    record.totp_secret_encrypted = null;
    record.totp_pending_secret_encrypted = null;
    record.totp_pending_expires_at = null;
    record.totp_last_used_step = null;
    record.recovery.clear();
  },
  async isInitialAdminSetupComplete() {
    return initialSetupComplete;
  },
  async createInitialAdmin(username, password, name, pendingSecret) {
    if (initialSetupComplete || [...userAccounts.values()].some(record => record.role === 'admin')) {
      throw new Error('Already set up');
    }
    initialSetupComplete = true;
    const record = account({ id: nextId++, username, role: 'admin' });
    record.password = password;
    record.name = name;
    record.totp_pending_secret_encrypted = pendingSecret;
    record.totp_pending_expires_at = Date.now() + 10 * 60 * 1000;
    userAccounts.set(record.id, record);
    return record.id;
  },
  async createAdditionalAdmin(username, password, name) {
    if ([...userAccounts.values()].some(record => record.username === username)) {
      const error = new Error('duplicate');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    const record = account({ id: nextId++, username, role: 'admin' });
    record.password = password;
    record.name = name;
    userAccounts.set(record.id, record);
    return record.id;
  }
};

require.cache[userModelPath] = {
  id: userModelPath, filename: userModelPath, loaded: true,
  exports: fakeUserModel, children: [], paths: []
};
require.cache[securityModelPath] = {
  id: securityModelPath, filename: securityModelPath, loaded: true,
  exports: fakeSecurityModel, children: [], paths: []
};

const authRoutes = require('../routes/authRoutes');
const { isAdmin, isLoggedIn, isPetOwner } = require('../middleware/auth');
let server;
let baseUrl;

before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', require('node:path').join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    name: 'auth-test.sid',
    secret: 'authenticator-admin-route-test-secret-at-least-32-bytes',
    resave: false,
    saveUninitialized: false
  }));
  app.use(flash());
  app.use(authRoutes);
  app.get('/dashboard', isLoggedIn, isPetOwner, (req, res) => res.send('user-dashboard'));
  app.get('/admin/dashboard', isAdmin, (req, res) => res.send('admin-dashboard'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (originalUserModel) require.cache[userModelPath] = originalUserModel;
  else delete require.cache[userModelPath];
  if (originalSecurityModel) require.cache[securityModelPath] = originalSecurityModel;
  else delete require.cache[securityModelPath];
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function cookieFrom(response) {
  const value = response.headers.get('set-cookie');
  return value ? value.split(';', 1)[0] : null;
}

function csrfFrom(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] || null;
}

async function getPage(route, cookie) {
  const response = await fetch(baseUrl + route, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual'
  });
  return { response, html: await response.text(), cookie: cookieFrom(response) || cookie };
}

async function post(route, cookie, fields, pageRoute = route) {
  const page = await getPage(pageRoute, cookie);
  const token = csrfFrom(page.html);
  assert.ok(token, `missing CSRF token on ${pageRoute}: ${page.response.status} ${page.html}`);
  const response = await fetch(baseUrl + route, {
    method: 'POST',
    headers: {
      Cookie: page.cookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ ...fields, _csrf: token }),
    redirect: 'manual'
  });
  return { response, html: await response.text(), cookie: cookieFrom(response) || page.cookie };
}

async function postWithoutFetchingForm(route, cookie, fields = {}) {
  const response = await fetch(baseUrl + route, {
    method: 'POST',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(fields),
    redirect: 'manual'
  });
  return { response, html: await response.text(), cookie: cookieFrom(response) || cookie };
}

async function currentCode(secret) {
  return generate({ secret, epoch: Math.floor(Date.now() / 1000) });
}

async function invalidCode(secret) {
  for (let value = 0; value < 1000000; value += 1) {
    const candidate = String(value).padStart(6, '0');
    if (!(await totp.verifyTotp(candidate, secret)).valid) return candidate;
  }
  throw new Error('Unable to find a nonmatching TOTP value.');
}

async function passwordLogin(route, username, cookie = null) {
  const loginPage = await getPage(route, cookie);
  return post(route, loginPage.cookie, {
    username,
    password: 'strong-test-password'
  }, route);
}

test('TOTP encrypts secrets, verifies RFC-style codes, expires old codes and rejects replay', async () => {
  const secret = generateSecret();
  const encrypted = totp.encryptSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(totp.decryptSecret(encrypted), secret);

  const epoch = Math.floor(Date.now() / 1000);
  const code = await generate({ secret, epoch });
  const verified = await totp.verifyTotp(code, secret, 0);
  assert.equal(verified.valid, true);
  const replay = await totp.verifyTotp(code, secret, verified.timeStep);
  assert.equal(replay.valid, false);
  const expired = await verifyOtp({
    secret,
    token: code,
    epoch: epoch + 120,
    epochTolerance: 30
  });
  assert.equal(expired.valid, false);
});

test('proposed security migration is additive and permanently records bootstrap state', async () => {
  const migration = await fs.readFile(
    path.join(projectRoot, 'migrations', 'PROPOSED_authenticator_and_admin_setup.sql'),
    'utf8'
  );
  assert.match(migration, /ADD COLUMN totp_enabled/);
  assert.match(migration, /totp_secret_encrypted/);
  assert.match(migration, /pomi_totp_recovery_codes/);
  assert.match(migration, /pomi_admin_setup_state/);
  assert.match(migration, /EXISTS \(SELECT 1 FROM users WHERE role = 'admin'\)/);
  assert.match(migration, /pomi_sessions/);
  assert.doesNotMatch(migration, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\s+users\b/i);
});

test('security screens include responsive and reduced-motion styling', async () => {
  const stylesheet = await fs.readFile(path.join(projectRoot, 'public', 'css', 'pomi-security.css'), 'utf8');
  assert.match(stylesheet, /@media\s*\(max-width:\s*520px\)/);
  assert.match(stylesheet, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(stylesheet, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test('login, signup and Admin setup render CSRF tokens and reject missing tokens', async () => {
  for (const route of ['/login', '/signup', '/admin/login', '/admin/setup']) {
    const page = await getPage(route);
    assert.match(csrfFrom(page.html) || '', /^[a-f0-9]{64}$/, `invalid CSRF token on ${route}`);
    const rejected = await postWithoutFetchingForm(route, page.cookie, {});
    assert.equal(rejected.response.status, 403, `${route} should reject a missing CSRF token`);
  }

  const loginPage = await getPage('/login');
  const token = csrfFrom(loginPage.html);
  const accepted = await postWithoutFetchingForm('/login', loginPage.cookie, {
    _csrf: token,
    username: 'unknown-account',
    password: 'invalid-password'
  });
  assert.equal(accepted.response.status, 302);
  assert.equal(accepted.response.headers.get('location'), '/login');
});

test('existing User login stays password-only by default and rotates the session', async () => {
  const initial = await getPage('/login');
  const response = await post('/login', initial.cookie, {
    username: user.username,
    password: 'strong-test-password'
  });
  assert.equal(response.response.status, 302);
  assert.equal(response.response.headers.get('location'), '/dashboard');
  assert.notEqual(response.cookie, initial.cookie);
  assert.equal((await fetch(baseUrl + '/dashboard', { headers: { Cookie: response.cookie } })).status, 200);
});

test('Admin credentials are not accepted through User login', async () => {
  const response = await passwordLogin('/login', admin.username);
  assert.equal(response.response.status, 302);
  assert.equal(response.response.headers.get('location'), '/login');
  assert.equal((await getPage('/login', response.cookie)).html.includes('Invalid username or password.'), true);
});

test('User signup always assigns User role regardless of submitted role', async () => {
  const response = await post('/signup', null, {
    username: 'new-owner',
    password: 'simple-valid-password',
    name: 'New Owner',
    role: 'admin'
  });
  assert.equal(response.response.status, 302);
  assert.equal(userAccounts.get(nextId - 1).role, 'user');
});

test('enabled User 2FA blocks password-only access and rejects invalid, expired and reused codes', async () => {
  const login = await passwordLogin('/login', protectedUser.username);
  assert.equal(login.response.headers.get('location'), '/login/2fa');
  assert.equal(login.response.headers.get('set-cookie') !== null, true);
  assert.equal((await fetch(baseUrl + '/dashboard', {
    headers: { Cookie: login.cookie },
    redirect: 'manual'
  })).status, 302);

  const invalid = await post('/login/2fa', login.cookie, {
    code: await invalidCode(userWithTotpSecret)
  });
  assert.equal(invalid.response.status, 302);
  assert.equal(invalid.response.headers.get('location'), '/login/2fa');

  const code = await currentCode(userWithTotpSecret);
  const verified = await post('/login/2fa', login.cookie, { code });
  assert.equal(verified.response.status, 302);
  assert.equal(verified.response.headers.get('location'), '/dashboard');
  assert.notEqual(verified.cookie, login.cookie);

  const nextLogin = await passwordLogin('/login', protectedUser.username);
  const replay = await post('/login/2fa', nextLogin.cookie, { code });
  assert.equal(replay.response.status, 302);
  assert.equal(replay.response.headers.get('location'), '/login/2fa');
});

test('Users can enable and disable optional 2FA only after credential reauthentication', async () => {
  const login = await passwordLogin('/login', user.username);
  const missingPassword = await post('/account/security/2fa/setup/start', login.cookie, {
    password: ''
  }, '/account/security');
  assert.equal(missingPassword.response.headers.get('location'), '/account/security');
  assert.equal(user.totp_pending_secret_encrypted, null);

  const setup = await post('/account/security/2fa/setup/start', login.cookie, {
    password: 'strong-test-password'
  }, '/account/security');
  assert.equal(setup.response.headers.get('location'), '/account/security/2fa/setup');
  const pendingSecret = totp.decryptSecret(user.totp_pending_secret_encrypted);
  const confirmed = await post('/account/security/2fa/setup', setup.cookie, {
    code: await currentCode(pendingSecret)
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(user.totp_enabled, 1);
  assert.match(confirmed.html, /Save your recovery codes/);

  user.totp_last_used_step = null;
  const disabled = await post('/account/security/2fa/disable', setup.cookie, {
    password: 'strong-test-password',
    code: await currentCode(pendingSecret)
  }, '/account/security');
  assert.equal(disabled.response.headers.get('location'), '/account/security');
  assert.equal(user.totp_enabled, 0);
});

test('five guessed TOTP values lock verification until the configured lock expires', async () => {
  const login = await passwordLogin('/login', protectedUser.username);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await post('/login/2fa', login.cookie, {
      code: await invalidCode(userWithTotpSecret)
    });
    assert.equal(result.response.headers.get('location'), '/login/2fa');
  }
  assert.equal((await fakeSecurityModel.findAccountById(protectedUser.id)).totp_is_locked, true);
  const blocked = await post('/login/2fa', login.cookie, { code: await currentCode(userWithTotpSecret) });
  assert.equal(blocked.response.headers.get('location'), '/login/2fa');
});

test('Admin login requires enrollment and does not authorize Admin routes before TOTP confirmation', async () => {
  const login = await passwordLogin('/admin/login', admin.username);
  assert.equal(login.response.headers.get('location'), '/admin/2fa/setup');
  assert.equal((await fetch(baseUrl + '/admin/dashboard', { headers: { Cookie: login.cookie } })).status, 401);

  const setupPage = await getPage('/admin/2fa/setup', login.cookie);
  assert.match(setupPage.html, /Authenticator setup QR code/);
  assert.match(setupPage.html, /Manual setup key/);
  const pendingSecret = totp.decryptSecret(admin.totp_pending_secret_encrypted);
  const code = await currentCode(pendingSecret);
  const confirmed = await post('/admin/2fa/setup', login.cookie, { code });
  assert.equal(confirmed.response.status, 200);
  assert.match(confirmed.html, /Save your recovery codes/);
  assert.notEqual(confirmed.cookie, login.cookie);
  assert.equal((await fetch(baseUrl + '/admin/dashboard', { headers: { Cookie: confirmed.cookie } })).status, 200);
});

test('repeated invalid Admin enrollment codes block even a later valid confirmation', async () => {
  const enrollmentAdmin = account({ id: 20, username: 'enrollment-admin', role: 'admin' });
  userAccounts.set(enrollmentAdmin.id, enrollmentAdmin);
  const login = await passwordLogin('/admin/login', enrollmentAdmin.username);
  const secret = totp.decryptSecret(enrollmentAdmin.totp_pending_secret_encrypted);
  const invalid = await invalidCode(secret);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await post('/admin/2fa/setup', login.cookie, { code: invalid });
    assert.equal(result.response.headers.get('location'), '/admin/2fa/setup');
  }
  const valid = await post('/admin/2fa/setup', login.cookie, {
    code: await currentCode(secret)
  });
  assert.equal(valid.response.headers.get('location'), '/admin/2fa/setup');
  assert.equal(enrollmentAdmin.totp_enabled, 0);
  assert.equal((await fetch(baseUrl + '/admin/dashboard', {
    headers: { Cookie: valid.cookie }
  })).status, 401);
  userAccounts.delete(enrollmentAdmin.id);
});

test('public setup token bootstraps once, and normal Users cannot sign in as Admin', async () => {
  userAccounts.delete(admin.id);
  initialSetupComplete = false;
  const setupPage = await getPage('/admin/setup');
  assert.doesNotMatch(setupPage.html, new RegExp(process.env.POMI_ADMIN_SETUP_TOKEN));

  const invalid = await post('/admin/setup', setupPage.cookie, {
    setup_token: 'invalid-token',
    username: 'first-admin',
    name: 'First Admin',
    password: 'long-and-unique-admin-password'
  });
  assert.equal(invalid.response.status, 302);
  assert.equal([...userAccounts.values()].filter(record => record.role === 'admin').length, 0);

  const created = await post('/admin/setup', setupPage.cookie, {
    setup_token: process.env.POMI_ADMIN_SETUP_TOKEN,
    username: 'first-admin',
    name: 'First Admin',
    password: 'long-and-unique-admin-password'
  });
  assert.equal(created.response.headers.get('location'), '/admin/2fa/setup');
  assert.equal(initialSetupComplete, true);
  const firstAdmin = [...userAccounts.values()].find(record => record.username === 'first-admin');
  const setupSecret = totp.decryptSecret(firstAdmin.totp_pending_secret_encrypted);
  const verified = await post('/admin/2fa/setup', created.cookie, {
    code: await currentCode(setupSecret)
  });
  assert.equal(verified.response.status, 200);
  assert.equal((await getPage('/admin/setup')).response.status, 410);

  const userDenied = await passwordLogin('/admin/login', user.username);
  assert.equal(userDenied.response.headers.get('location'), '/admin/login');
  assert.equal((await fetch(baseUrl + '/admin/dashboard', { headers: { Cookie: userDenied.cookie } })).status, 401);
  userAccounts.set(admin.id, admin);
});

test('additional Admin creation requires password and fresh TOTP, and recovery codes are single-use', async () => {
  admin.totp_enabled = 1;
  admin.totp_secret_encrypted = totp.encryptSecret(userWithTotpSecret);
  admin.totp_last_used_step = null;
  const login = await passwordLogin('/admin/login', admin.username);
  assert.equal(login.response.headers.get('location'), '/admin/2fa/verify');
  const authenticated = await post('/admin/2fa/verify', login.cookie, {
    code: await currentCode(userWithTotpSecret)
  });
  assert.equal(authenticated.response.status, 302);
  assert.equal(authenticated.response.headers.get('location'), '/admin/dashboard');

  const creationCode = await currentCode(userWithTotpSecret);
  admin.totp_last_used_step = null;
  const created = await post('/admin/accounts', authenticated.cookie, {
    username: 'second-admin',
    name: 'Second Admin',
    password: 'another-long-unique-password',
    current_password: 'strong-test-password',
    code: creationCode
  }, '/admin/accounts/new');
  assert.equal(created.response.headers.get('location'), '/admin/accounts');
  assert.equal([...userAccounts.values()].find(record => record.username === 'second-admin').role, 'admin');

  const recovery = totp.createRecoveryCodes();
  admin.recovery = new Set(recovery.verifiers);
  const recoveryCode = recovery.codes[0];
  const recoveryLogin = await passwordLogin('/admin/login', admin.username);
  const usedRecovery = await post('/admin/2fa/verify', recoveryLogin.cookie, { code: recoveryCode });
  assert.equal(usedRecovery.response.headers.get('location'), '/admin/dashboard');
  const secondLogin = await passwordLogin('/admin/login', admin.username);
  const reusedRecovery = await post('/admin/2fa/verify', secondLogin.cookie, { code: recoveryCode });
  assert.equal(reusedRecovery.response.headers.get('location'), '/admin/2fa/verify');
});

test('unauthenticated requests are redirected and CSRF-protected logout destroys the session', async () => {
  const denied = await fetch(baseUrl + '/dashboard', { redirect: 'manual' });
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get('location'), '/login');

  const login = await passwordLogin('/login', user.username);
  const missingCsrf = await postWithoutFetchingForm('/logout', login.cookie);
  assert.equal(missingCsrf.response.status, 403);
  const signedOut = await post('/logout', login.cookie, {}, '/login');
  assert.equal(signedOut.response.status, 302);
  assert.equal(signedOut.response.headers.get('location'), '/login');
  assert.equal((await fetch(baseUrl + '/dashboard', {
    headers: { Cookie: login.cookie },
    redirect: 'manual'
  })).status, 302);
});
