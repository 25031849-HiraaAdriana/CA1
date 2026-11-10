const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
const express = require('express');
const session = require('express-session');

const modelPath = require.resolve('../models/medicationRefillModel');
const queries = [];
require.cache[modelPath] = {
  id: modelPath, filename: modelPath, loaded: true, children: [], paths: [],
  exports: {
    isFeatureReady: async () => true,
    getOwnerAcceptedDemoRefills: async owner => {
      queries.push(owner);
      return owner === 7 ? [{
        id: 33, pet_id: 1, pet_name: 'Milo', medication_name: 'Medication A', demo_price_cents: 1234
      }] : [];
    }
  }
};
const cart = require('../controllers/refillCartController');
const { isPetOwner } = require('../middleware/auth');
const { csrfToken, csrfProtection } = require('../middleware/csrf');
let server;
let base;

before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'offline-demo-cart', resave: false, saveUninitialized: false }));
  app.get('/login/:role/:id', (req, res) => {
    req.session.user = { id: Number(req.params.id), role: req.params.role, name: 'Test' };    req.session.csrfToken = 'test-token';
    res.sendStatus(204);
  });
  app.get('/refill-cart', isPetOwner, csrfToken, cart.viewCart);
  app.post('/refill-cart/:requestId/fulfilment', isPetOwner, csrfProtection, cart.setDelivery);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
async function login(role, id) {
  return (await fetch(`${base}/login/${role}/${id}`)).headers.get('set-cookie').split(';', 1)[0];
}
async function getCart(cookie) {
  const response = await fetch(`${base}/refill-cart`, { headers: { Cookie: cookie } });
  return { response, html: await response.text() };
}

test('owner cart is separate, deduplicated and calculates session choices in cents', async () => {
  const cookie = await login('user', 7);
  let { html } = await getCart(cookie);
  assert.equal((html.match(/<h2>Medication A<\/h2>/g) || []).length, 1);
  assert.match(html, /S\$12\.34/);
  assert.match(html, /not recorded for this historical request/);
  const token = html.match(/name="_csrf" value="([^"]+)"/)[1];
  for (const [option, expected] of [['delivery', 'S$22.34'], ['collection', 'S$12.34']]) {
    const response = await fetch(`${base}/refill-cart/33/fulfilment`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: token, fulfilment: option })
    });
    assert.equal(response.status, 302);
    ({ html } = await getCart(cookie));
    assert.match(html, new RegExp(expected.replace('$', '\\$')));
  }
  assert.ok(queries.every(owner => owner === 7));
});

test('cart blocks other users, Admins, forged IDs and missing CSRF', async () => {
  const owner = await login('user', 7);
  const other = await login('user', 8);
  const admin = await login('admin', 1);
  const denied = await fetch(`${base}/refill-cart`, { headers: { Cookie: admin }, redirect: 'manual' });
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get('location'), '/admin/dashboard');
  const otherCart = await getCart(other);
  assert.doesNotMatch(otherCart.html, /Medication A/);
  const noCsrf = await fetch(`${base}/refill-cart/33/fulfilment`, {
    method: 'POST', headers: { Cookie: owner, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ fulfilment: 'delivery' })
  });
  assert.equal(noCsrf.status, 403);
  const forged = await fetch(`${base}/refill-cart/33/fulfilment`, {
    method: 'POST', headers: { Cookie: other, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: 'test-token', fulfilment: 'delivery' })
  });
  assert.equal(forged.status, 404);
  const invalid = await fetch(`${base}/refill-cart/33/fulfilment`, {
    method: 'POST', headers: { Cookie: owner, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: 'test-token', fulfilment: 'free-delivery' })
  });
  assert.equal(invalid.status, 400);
});
