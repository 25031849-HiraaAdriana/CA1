const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const path = require('node:path');
const ejs = require('ejs');

const userModelPath = require.resolve('../models/userModel');
const petModelPath = require.resolve('../models/petModel');
const petShopModelPath = require.resolve('../models/petShopModel');
const refillModelPath = require.resolve('../models/medicationRefillModel');
const appointmentModelPath = require.resolve('../models/appointmentModel');
const originalUserModel = require.cache[userModelPath];
const originalPetModel = require.cache[petModelPath];
const originalPetShopModel = require.cache[petShopModelPath];
const originalRefillModel = require.cache[refillModelPath];
const originalAppointmentModel = require.cache[appointmentModelPath];
let authenticatedUsers = [{ id: 7, name: 'Test User', role: 'user' }];

require.cache[userModelPath] = {
  id: userModelPath,
  filename: userModelPath,
  loaded: true,
  exports: {
    findByCredentials(username, passwordHash, callback) {
      callback(null, authenticatedUsers);
    }
  },
  children: [],
  paths: []
};
require.cache[petModelPath] = {
  id: petModelPath,
  filename: petModelPath,
  loaded: true,
  exports: {
    getPetsByOwner(ownerId, callback) {
      callback(null, []);
    }
  },
  children: [],
  paths: []
};
require.cache[petShopModelPath] = {
  id: petShopModelPath,
  filename: petShopModelPath,
  loaded: true,
  exports: {
    isFeatureReady: async () => true,
    getFavouriteProducts: async () => [],
    getRecentlyViewedProducts: async () => []
  },
  children: [],
  paths: []
};
require.cache[refillModelPath] = {
  id: refillModelPath, filename: refillModelPath, loaded: true,
  exports: { isFeatureReady: async () => true, getOwnerAcceptedDemoRefills: async () => [] },
  children: [], paths: []
};
require.cache[appointmentModelPath] = {
  id: appointmentModelPath, filename: appointmentModelPath, loaded: true,
  exports: { nextForOwner: async () => null }, children: [], paths: []
};

const authController = require('../controllers/authController');
const indexController = require('../controllers/indexController');

test('login success is shown once on the User Dashboard and never queued as a generic flash', async () => {
  const flashCalls = [];
  const loginSession = { returnTo: undefined };
  let loginRedirect;
  authController.login({
    body: { username: 'test', password: 'test' },
    session: loginSession,
    flash: (...args) => flashCalls.push(args)
  }, {
    redirect: location => { loginRedirect = location; }
  });

  assert.equal(loginRedirect, '/dashboard');
  assert.equal(loginSession.loginSuccess, true);
  assert.deepEqual(flashCalls, []);

  let firstDashboard;
  indexController.dashboard({
    session: { user: authenticatedUsers[0], loginSuccess: true }
  }, {
    render: (template, locals) => { firstDashboard = { template, locals }; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firstDashboard.template, 'userDashboard');
  assert.equal(firstDashboard.locals.loginSuccessMessage, 'Login successful!');
  assert.equal(firstDashboard.locals.pets.length, 0);

  let refreshedDashboard;
  const refreshedSession = { user: authenticatedUsers[0] };
  indexController.dashboard({ session: refreshedSession }, {
    render: (template, locals) => { refreshedDashboard = locals; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshedDashboard.loginSuccessMessage, null);
  assert.equal(Object.hasOwn(refreshedSession, 'loginSuccess'), false);
});

test('login return-to navigation does not leave a stale Dashboard success message', () => {
  const loginSession = { returnTo: '/shop/collections/animal-food-beverages' };
  let loginRedirect;
  authController.login({
    body: { username: 'test', password: 'test' },
    session: loginSession,
    flash() {}
  }, {
    redirect: location => { loginRedirect = location; }
  });
  assert.equal(loginRedirect, '/shop/collections/animal-food-beverages');
  assert.equal(loginSession.loginSuccess, false);
});

test('invalid login continues to use the existing error flash', () => {
  authenticatedUsers = [];
  const flashCalls = [];
  let loginRedirect;
  authController.login({
    body: { username: 'test', password: 'bad-password' },
    session: {},
    flash: (...args) => flashCalls.push(args)
  }, {
    redirect: location => { loginRedirect = location; }
  });
  assert.equal(loginRedirect, '/login');
  assert.deepEqual(flashCalls, [['error', 'Invalid username or password.']]);
  authenticatedUsers = [{ id: 7, name: 'Test User', role: 'user' }];
});

test('payment reminder shows quotation, status and demo safeguards', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'userDashboard.ejs'), {
    session: { user: { name: 'Owner', role: 'user' } },
    pets: [], loginSuccessMessage: null, successMessage: null, errorMessage: null,
    favourites: [], recentlyViewed: [], shopHistoryReady: true, csrfToken: 'token',
    refillReady: true,
    refillReminders: [{ medication_name: 'Medicine', pet_name: 'Milo', displayPrice: 'S$12.34' }]
  });
  assert.match(html, /Medication Refill Payment Reminder/);
  assert.match(html, /Medicine/);
  assert.match(html, /Milo/);
  assert.match(html, /S\$12\.34/);
  assert.match(html, /href="\/refill-cart"/);
  assert.match(html, /Payment is planned for CA2 and unavailable now/);
  assert.match(html, /Status: Ready for Test Payment/);
  assert.match(html, /not clinical approval or medication supply/);
  assert.doesNotMatch(html, /CA1 demonstration/);
  assert.match(html, /tel:\+6562660232/);
});

test('no payment reminder is rendered when there are no accepted unpaid quotations', async () => {
  for (const refillReady of [true, false]) {
    const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'userDashboard.ejs'), {
      session: { user: { name: 'Owner', role: 'user' } },
      pets: [], loginSuccessMessage: null, successMessage: null, errorMessage: null,
      favourites: [], recentlyViewed: [], shopHistoryReady: true, csrfToken: 'token',
      refillReady, refillReminders: []
    });
    assert.doesNotMatch(html, /Medication Refill Payment Reminder/);
    if (!refillReady) assert.match(html, /Refill reminders are currently unavailable/);
  }
});

test('Digital Health Passport cards show pet photos or an accessible fallback and retain both links', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '..', 'views', 'userDashboard.ejs'), {
    session: { user: { name: 'Owner', role: 'user' } },
    pets: [
      {
        id: 12, name: 'Milo', imageUrl: '/images/milo.jpg', species: 'Dog', breed: 'Shiba Inu',
        avs_licence_number: 'AVS-123', microchip_id: 'CHIP-123'
      },
      {
        id: 13, name: 'Luna', imageUrl: null, species: 'Cat', breed: 'Domestic Shorthair',
        avs_licence_number: null, microchip_id: null
      }
    ],
    loginSuccessMessage: null,
    successMessage: null,
    errorMessage: null,
    favourites: [],
    recentlyViewed: [],
    shopHistoryReady: true,
    csrfToken: 'passport-token',
    refillReady: false,
    refillReminders: [],
    appointmentsAvailable: true,
    nextAppointment: null,
    currentPath: '/dashboard'
  });

  assert.match(html, /<img src="\/images\/milo\.jpg" alt="Photo of Milo">/);
  assert.match(html, /aria-label="No photo on file for Luna"/);
  assert.match(html, /class="passport-photo-fallback"[^]*?<svg viewBox="0 0 64 64"/);
  assert.match(html, /View Health Passport/);
  assert.match(html, /href="\/pets\/12\/medical-records"/);
  assert.match(html, /href="\/pets\/12">/);
  assert.match(html, /Not on file/);
});

test('appointment summary formats Singapore time and shows compact owner actions', async () => {
  const render = nextAppointment => ejs.renderFile(path.join(__dirname, '..', 'views', 'userDashboard.ejs'), {
    session: { user: { name: 'Owner', role: 'user' } },
    pets: [], loginSuccessMessage: null, successMessage: null, errorMessage: null,
    favourites: [], recentlyViewed: [], shopHistoryReady: true, csrfToken: 'dashboard-token',
    refillReady: true, refillReminders: [], appointmentsAvailable: true, nextAppointment
  });
  const appointment = {
    id: '42', appointment_type: 'Checkup', pet_name: 'Butch', clinic_name: 'Canopy Vet',
    appointment_date: '2026-11-17', appointment_time: '15:00'
  };
  const html = await render(appointment);
  assert.match(html, /Checkup · Butch/);
  assert.match(html, /Canopy Vet/);
  assert.match(html, /17 Nov 2026, 3:00 PM<\/time> \(Singapore time\)/);
  assert.match(html, /href="\/appointments\/42\/edit">Choose Another Date/);
  assert.match(html, /action="\/appointments\/42\/cancel"/);
  assert.match(html, /name="_csrf" value="dashboard-token"/);
  assert.doesNotMatch(html, /View appointments|Manage appointments/);
  assert.match(await render({ ...appointment, appointment_time: '00:05' }), /12:05 AM/);
  assert.match(await render({ ...appointment, appointment_time: '12:00' }), /12:00 PM/);
  const empty = await render(null);
  assert.match(empty, /No upcoming appointments/);
  assert.doesNotMatch(empty, /Add an appointment|href="\/appointments\/new"/);
});

after(() => {
  if (originalUserModel) require.cache[userModelPath] = originalUserModel;
  else delete require.cache[userModelPath];
  if (originalPetModel) require.cache[petModelPath] = originalPetModel;
  else delete require.cache[petModelPath];
  if (originalPetShopModel) require.cache[petShopModelPath] = originalPetShopModel;
  else delete require.cache[petShopModelPath];
  if (originalRefillModel) require.cache[refillModelPath] = originalRefillModel;
  else delete require.cache[refillModelPath];
  if (originalAppointmentModel) require.cache[appointmentModelPath] = originalAppointmentModel;
  else delete require.cache[appointmentModelPath];
});
