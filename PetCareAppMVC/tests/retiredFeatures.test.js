const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, test } = require('node:test');
const express = require('express');
const ejs = require('ejs');
const session = require('express-session');
const clinics = require('../data/veterinaryClinics');

const connectionPath = require.resolve('../config/db');
const originalConnection = require.cache[connectionPath];
const testDatabase = {
  async query() {
    return [[], []];
  }
};
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: {
    promise: () => testDatabase,
    query() {},
    createPetShopTransactionConnection: () => ({
      promise: () => testDatabase
    })
  },
  children: [],
  paths: []
};
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'retired-feature-route-tests',
  resave: false,
  saveUninitialized: false
}));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/test-login/:role', (req, res) => {
  req.session.user = { id: 1, name: 'Test User', role: req.params.role };  res.sendStatus(204);
});
app.use(require('../routes/adminRoutes'));
app.use(require('../routes/petRoutes'));
app.use(require('../routes/veterinaryRoutes'));

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (originalConnection) require.cache[connectionPath] = originalConnection;
  else delete require.cache[connectionPath];
});

test('User and Admin navigation omit retired prescription modules and retain active links', async () => {
  const navbarPath = path.join(__dirname, '..', 'views', 'partials', 'navbar.ejs');
  const roleCases = [
    {
      role: 'user',
      expectedLinks: ['/dashboard', '/cart', '/pets/new', '/shop']
    },
    {
      role: 'admin',
      expectedLinks: [
        '/admin/dashboard', '/admin/products', '/admin/activity-history', '/admin/users'
      ]
    }
  ];

  for (const { role, expectedLinks } of roleCases) {
    const html = await ejs.renderFile(navbarPath, {
      session: { user: { id: 1, name: 'Test User', role } },
      currentPath: '/dashboard',
      cartCount: 0
    });
    for (const link of expectedLinks) assert.ok(html.includes(`href="${link}"`), `${role} should retain ${link}`);
    if (role === 'user') {
      const menu = html.match(/<div class="portal-navigation"[^]*?<\/ul>/)[0];
      const links = [...menu.matchAll(/<li><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/li>/g)]
        .map(match => [match[1], match[2].trim()]);
      assert.deepEqual(links, [
        ['/dashboard', 'Dashboard'], ['/dashboard#digital-health-passport', 'My Pets'],
        ['/pets/new', 'Register a Pet'], ['/shop', 'Pomi Store']
      ]);
      assert.doesNotMatch(html, /href="\/vets"/);
      assert.match(html, /class="portal-cart[^"]*" href="\/cart" aria-label="Shopping Cart"/);
      assert.match(html, /class="portal-cart[^]*?<svg/);
      assert.match(html, /<\/ul>\s*<\/div>\s*<a class="portal-cart/);
    }
    assert.doesNotMatch(html, /\/prescriptions|prescription-requests|prescription-medications|Medication availability/i);
  }
});

test('retired prescription endpoints return 404 while surviving role protections remain active', async () => {
  const applicationSource = fs.readFileSync(
    path.join(__dirname, '..', 'app.js'),
    'utf8'
  );
  assert.doesNotMatch(applicationSource, /prescriptionRequestRoutes/);

  for (const route of [
    '/prescriptions',
    '/prescriptions/new',
    '/prescriptions/1',
    '/prescriptions/1/messages',
    '/prescriptions/1/availability-enquiries',
    '/admin/prescription-requests',
    '/admin/prescription-requests/1',
    '/admin/prescription-medications'
  ]) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 404, `${route} should be retired`);
  }

  const retiredCreate = await fetch(`${baseUrl}/prescriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: ''
  });
  assert.equal(retiredCreate.status, 404);

  const adminDashboard = await fetch(`${baseUrl}/admin/dashboard`);
  assert.equal(adminDashboard.status, 401);
  const petRegistration = await fetch(`${baseUrl}/pets/new`, { redirect: 'manual' });
  assert.equal(petRegistration.status, 302);
  assert.equal(petRegistration.headers.get('location'), '/login');

  const unauthenticatedDirectory = await fetch(`${baseUrl}/vets`, { redirect: 'manual' });
  assert.equal(unauthenticatedDirectory.status, 302);
  assert.equal(unauthenticatedDirectory.headers.get('location'), '/login');
});

test('veterinary directory is User-only and separates emergency from regular clinics', async () => {
  const adminCookieResponse = await fetch(`${baseUrl}/test-login/admin`);
  const adminCookie = adminCookieResponse.headers.get('set-cookie').split(';', 1)[0];
  const adminDirectory = await fetch(`${baseUrl}/vets`, {
    headers: { Cookie: adminCookie },
    redirect: 'manual'
  });
  assert.equal(adminDirectory.status, 302);
  assert.equal(adminDirectory.headers.get('location'), '/admin/dashboard');

  const userCookieResponse = await fetch(`${baseUrl}/test-login/user`);
  const userCookie = userCookieResponse.headers.get('set-cookie').split(';', 1)[0];
  const response = await fetch(`${baseUrl}/vets`, { headers: { Cookie: userCookie } });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Veterinary Care &amp; Emergency Contacts/);
  assert.match(html, /24-Hour Emergency Veterinary Services/);
  assert.match(html, /Regular Veterinary Clinics/);
  assert.doesNotMatch(html, /Find Vets Near Me|Use My Location|navigator\.geolocation|nearby-results|Haversine/i);
  assert.match(html, /<h2 id="veterinary-before-visit-title">Before You Visit<\/h2>/);
  assert.ok(html.includes('Clinic operating hours, availability, and services may change. Please contact the clinic directly to confirm that it can accommodate your pet\'s needs. Pomi provides these listings for informational purposes only and is not affiliated with the listed veterinary clinics.'));
  assert.equal((html.match(/data-clinic-card/g) || []).length, 11);
  assert.equal((html.match(/data-category="emergency"/g) || []).length, 5);
  assert.equal((html.match(/data-category="regular"/g) || []).length, 6);
  assert.match(html, /href="tel:\+6562660232"/);
  assert.equal((html.match(/class="veterinary-directions-link"/g) || []).length, clinics.length);
  assert.equal((html.match(/class="veterinary-source-link"/g) || []).length, clinics.length);
  assert.doesNotMatch(html, /veterinary-call-button|Call unavailable|Get Directions unavailable|Phone from supplied list/);
  const cards = html.match(/<article class="veterinary-clinic-card[^>]*>[\s\S]*?<\/article>/g) || [];
  assert.equal(cards.length, clinics.length);
  cards.forEach((card, index) => {
    const actions = card.match(/class="veterinary-(?:directions-link|source-link)"/g) || [];
    assert.equal(actions.length, 2, `clinic card ${index + 1} should have exactly two actions`);
    assert.match(card, /class="veterinary-directions-link"/);
    assert.match(card, /class="veterinary-source-link"/);
    assert.match(card, /class="veterinary-phone"/);
  });
  for (const clinic of clinics) {
    assert.ok(html.includes(`href="tel:${clinic.telephoneLink}"`), `${clinic.name} should have a call action`);
    assert.ok(html.includes(`href="${clinic.directionsUrl.replace(/&/g, '&amp;')}"`),
      `${clinic.name} should have a directions action`);
    assert.ok(html.includes(`href="${clinic.website}"`), `${clinic.name} should have an official website action`);
  }
  for (const region of ['North', 'North-East', 'East', 'West', 'South', 'Central']) {
    assert.ok(html.includes(`data-region-filter="${region}"`), `${region} region filter should remain`);
  }
  for (const category of ['emergency', 'regular']) {
    assert.ok(html.includes(`data-service-filter="${category}"`), `${category} filter should remain`);
  }
  const emergencyPanel = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'partials', 'emergencyVeterinaryPanel.ejs'),
    {}
  );
  assert.match(emergencyPanel, /href="tel:\+6562660232"/);
  assert.doesNotMatch(emergencyPanel, /Call Now/);
  assert.match(emergencyPanel, /href="\/vets">Find Veterinary Clinics/);
});
