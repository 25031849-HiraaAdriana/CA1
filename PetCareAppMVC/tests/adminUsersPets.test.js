const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { before, after, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const users = [
  { id: 1, name: 'Admin', username: 'admin', role: 'admin' },
  { id: 7, name: 'Owner', username: 'owner', role: 'user' },
  { id: 8, name: 'No Pets', username: 'no-pets', role: 'user' }
];
const pets = [
  {
    id: 81, owner_id: 7, owner_name: 'Owner', name: 'Milo', species: 'Dog',
    breed: 'Shiba Inu', age: 4, avs_licence_number: 'AVS-123',
    microchip_id: 'MID-456', image: 'pethub-hero-dog.jpg', status: 'active'
  },
  {
    id: 82, owner_id: 7, owner_name: 'Owner', name: 'Luna', species: 'Hamster',
    breed: 'Syrian', age: 2, avs_licence_number: null,
    microchip_id: null, image: null, status: 'active'
  }
];
const petHistory = [{ pet_id: 81, kind: 'medical_record_signature' }, { pet_id: 81, kind: 'appointment' }];
const deletedUserIds = [];
const savedPetEdits = [];
const temporaryImages = [];
let duplicateIdentifiers = false;

function mock(module, exports) {
  const resolved = require.resolve(module);
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, children: [], paths: [], exports
  };
}

const userModel = {
  getAllUsers(callback) { callback(null, users.map(user => ({ ...user }))); },
  async findUser(userId) { return users.find(user => String(user.id) === String(userId)) || null; },
  async updateUserProfile(userId, profile) {
    const user = users.find(item => String(item.id) === String(userId));
    if (!user) return false;
    if (users.some(item => item.id !== user.id && item.username === profile.username)) {
      const error = new Error('Duplicate username');
      error.code = 'ER_DUP_ENTRY';
      throw error;
    }
    Object.assign(user, profile);
    return true;
  },
  async getUserDeletionTarget(userId) {
    const user = users.find(item => String(item.id) === String(userId));
    return user ? {
      ...user,
      has_pets: pets.some(pet => String(pet.owner_id) === String(user.id)) ? 1 : 0
    } : null;
  },
  async deleteUserIfNoPets(userId, username) {
    const index = users.findIndex(user => String(user.id) === String(userId) &&
      user.username === username && user.role === 'user' &&
      !pets.some(pet => String(pet.owner_id) === String(user.id)));
    if (index < 0) return false;
    deletedUserIds.push(users[index].id);
    users.splice(index, 1);
    return true;
  }
};

const petModel = {
  getPetsByOwner(ownerId, callback) {
    callback(null, pets.filter(pet => String(pet.owner_id) === String(ownerId) && pet.status === 'active'));
  },
  getAllPetsByOwner(ownerId, callback) {
    callback(null, pets.filter(pet => String(pet.owner_id) === String(ownerId)));
  },
  async getPetById(petId) {
    return pets.find(pet => String(pet.id) === String(petId)) || null;
  },
  async updatePetAsAdmin(petId, details) {
    if (duplicateIdentifiers) {
      const error = new Error('Duplicate pet identity');
      error.code = 'PET_IDENTIFIER_DUPLICATE';
      throw error;
    }
    const pet = pets.find(item => String(item.id) === String(petId));
    if (!pet) return null;
    const copy = { ...pet, ...details, image: details.image || pet.image };
    Object.assign(pet, {
      name: details.name, species: details.species, breed: details.breed,
      age: details.age, avs_licence_number: details.avsLicenceNumber,
      microchip_id: details.microchipId, image: copy.image
    });
    savedPetEdits.push(details);
    return copy;
  },
  async markPetDeceased(petId) {
    const pet = pets.find(item => String(item.id) === String(petId));
    if (!pet || pet.status !== 'active') return null;
    pet.status = 'deceased';
    return { ...pet };
  }
};

mock('../models/userModel', userModel);
mock('../models/petModel', petModel);
mock('../helpers/avsLicenceDocument', {
  async extractIdentifiers(buffer) {
    const text = buffer.toString('latin1');
    const avsLicenceNumber = text.match(/AVS-[A-Z0-9]+/)?.[0] || null;
    const microchipId = text.match(/MID-[A-Z0-9]+/)?.[0] || null;
    return { avsLicenceNumber, microchipId };
  }
});

let server;
let base;
before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'offline-admin-users-pets-tests', resave: false, saveUninitialized: false }));
  app.use(flash());
  app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    next();
  });
  app.get('/test-login/:role/:id', (req, res) => {
    const user = users.find(item => String(item.id) === req.params.id);
    req.session.user = user || { id: Number(req.params.id), role: req.params.role, name: req.params.role };    req.session.csrfToken = `token-${req.params.id}`;
    res.sendStatus(204);
  });
  app.use(require('../routes/adminRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await Promise.all(temporaryImages.map(file => fs.unlink(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  })));
});

async function login(id) {
  const response = await fetch(`${base}/test-login/${id === '1' ? 'admin' : 'user'}/${id}`);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

async function get(url, cookie) {
  const response = await fetch(base + url, { redirect: 'manual', headers: { Cookie: cookie } });
  return { response, html: await response.text() };
}

async function post(url, cookie, fields) {
  return fetch(base + url, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  });
}

test('Admin Users listing exposes View, Edit and a separate Delete confirmation step', async () => {
  const admin = await login('1');
  assert.equal((await get('/admin/users', await login('7'))).response.status, 403);
  const page = await get('/admin/users', admin);
  assert.equal(page.response.status, 200);
  assert.match(page.html, /\/admin\/users\/7">View/);
  assert.match(page.html, /\/admin\/users\/7\/edit">Edit/);
  assert.match(page.html, /\/admin\/users\/7\/delete">Delete/);
  assert.match(page.html, /pomi-admin-button-danger/);
  assert.equal((await get('/admin/users/delete/8', admin)).response.status, 302);
  assert.deepEqual(deletedUserIds, []);
});

test('Admin can edit account name and username; missing CSRF and duplicate usernames are rejected', async () => {
  const admin = await login('1');
  assert.equal((await post('/admin/users/7/edit', admin, {
    name: 'Updated Owner', username: 'owner-updated'
  })).status, 403);
  assert.equal(users.find(user => user.id === 7).name, 'Owner');
  let response = await post('/admin/users/7/edit', admin, {
    _csrf: 'token-1', name: 'Updated Owner', username: 'owner-updated'
  });
  assert.equal(response.status, 302);
  assert.equal(users.find(user => user.id === 7).name, 'Updated Owner');
  response = await post('/admin/users/7/edit', admin, {
    _csrf: 'token-1', name: 'Updated Owner', username: 'no-pets'
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /already in use/);
});

test('Admin user detail shows pet photo, identifiers only when recorded, age and status', async () => {
  const admin = await login('1');
  const page = await get('/admin/users/7', admin);
  assert.equal(page.response.status, 200);
  assert.match(page.html, /src="\/images\/pethub-hero-dog\.jpg"/);
  assert.match(page.html, /Pomi Pet ID/);
  assert.match(page.html, /AVS-123/);
  assert.match(page.html, /MID-456/);
  assert.match(page.html, /Not recorded/);
  assert.match(page.html, /Mark as deceased/);
});

test('User delete requires exact username confirmation and refuses accounts with pets', async () => {
  const admin = await login('1');
  let page = await get('/admin/users/7/delete', admin);
  assert.equal(page.response.status, 200);
  assert.match(page.html, /cannot be deleted/);
  assert.doesNotMatch(page.html, /name="confirm_username"/);
  assert.equal(await userModel.deleteUserIfNoPets(7, 'owner'), false);

  page = await get('/admin/users/8/delete', admin);
  assert.equal(page.response.status, 200);
  assert.match(page.html, /shopping cart, favourites and recently viewed/);
  assert.equal((await post('/admin/users/8/delete', admin, {
    _csrf: 'token-1', confirm_username: 'wrong'
  })).status, 409);
  assert.deepEqual(deletedUserIds, []);
  const response = await post('/admin/users/8/delete', admin, {
    _csrf: 'token-1', confirm_username: 'no-pets'
  });
  assert.equal(response.status, 302);
  assert.deepEqual(deletedUserIds, [8]);
});

test('Admin pet edit preserves photo when omitted and validates photo signature when replaced', async () => {
  const admin = await login('1');
  let page = await get('/admin/pets/81/edit', admin);
  assert.equal(page.response.status, 200);
  assert.match(page.html, /Pomi Pet ID #81/);
  assert.match(page.html, /name="pet_image"/);
  const noPhoto = {
    _csrf: 'token-1', pet_name: 'Milo', species: 'Dog', breed: 'Shiba Inu', age: '4',
    avs_licence_number: 'AVS-123', microchip_id: 'MID-456', correction_reason: ''
  };
  assert.equal((await post('/admin/pets/81/edit', admin, noPhoto)).status, 302);
  assert.equal(pets.find(pet => pet.id === 81).image, 'pethub-hero-dog.jpg');

  const form = new FormData();
  Object.entries({ ...noPhoto, pet_name: 'Milo Updated' }).forEach(([key, value]) => form.append(key, value));
  form.append('pet_image', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])], {
    type: 'image/png'
  }), 'pet.png');
  const response = await fetch(`${base}/admin/pets/81/edit`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: admin }, body: form
  });
  assert.equal(response.status, 302);
  assert.match(pets.find(pet => pet.id === 81).image, /^[0-9a-f-]+\.png$/);
  temporaryImages.push(path.join(__dirname, '..', 'public', 'images', pets.find(pet => pet.id === 81).image));
});

test('dog and cat identifier correction requires local AVS document match, reason and uniqueness', async () => {
  const admin = await login('1');
  const form = new FormData();
  const fields = {
    _csrf: 'token-1', pet_name: 'Milo Updated', species: 'Dog', breed: 'Shiba Inu', age: '4',
    avs_licence_number: 'AVS-789', microchip_id: 'MID-999', correction_reason: 'Updated from licence'
  };
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  const pdf = Buffer.from('%PDF-1.4 AVS-789 MID-999');
  form.append('avs_licence_document', new Blob([pdf], { type: 'application/pdf' }), 'licence.pdf');
  let response = await fetch(`${base}/admin/pets/81/edit`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: admin }, body: form
  });
  assert.equal(response.status, 302);
  const edit = savedPetEdits.at(-1);
  assert.equal(edit.documentMatchedLocally, true);
  assert.equal(edit.correctionReason, 'Updated from licence');

  const changedFields = {
    ...fields,
    avs_licence_number: 'AVS-888',
    microchip_id: 'MID-888',
    correction_reason: 'Updated identifier'
  };
  const mismatched = new FormData();
  Object.entries(changedFields).forEach(([key, value]) => mismatched.append(key, value));
  mismatched.append('avs_licence_document', new Blob([Buffer.from('%PDF-1.4 AVS-888 MID-OTHER')], {
    type: 'application/pdf'
  }), 'licence.pdf');
  const savedBeforeMismatch = savedPetEdits.length;
  response = await fetch(`${base}/admin/pets/81/edit`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: admin }, body: mismatched
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /does not locally match/);
  assert.equal(savedPetEdits.length, savedBeforeMismatch);

  duplicateIdentifiers = true;
  const duplicate = new FormData();
  Object.entries(changedFields).forEach(([key, value]) => duplicate.append(key, value));
  duplicate.append('avs_licence_document', new Blob([Buffer.from('%PDF-1.4 AVS-888 MID-888')], {
    type: 'application/pdf'
  }), 'licence.pdf');
  response = await fetch(`${base}/admin/pets/81/edit`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: admin }, body: duplicate
  });
  duplicateIdentifiers = false;
  assert.equal(response.status, 409);
  assert.match(await response.text(), /already registered/);
});

test('optional other-species microchip edits need no AVS PDF; regulated cross-species change is blocked', async () => {
  const admin = await login('1');
  const otherSpecies = await post('/admin/pets/82/edit', admin, {
    _csrf: 'token-1', pet_name: 'Luna', species: 'Hamster', breed: 'Syrian', age: '2',
    avs_licence_number: '', microchip_id: 'MID-888', correction_reason: 'Chip added'
  });
  assert.equal(otherSpecies.status, 302);
  assert.equal(pets.find(pet => pet.id === 82).microchip_id, 'MID-888');
  const blocked = await post('/admin/pets/81/edit', admin, {
    _csrf: 'token-1', pet_name: 'Milo Updated', species: 'Hamster', breed: 'Syrian', age: '4',
    avs_licence_number: '', microchip_id: '', correction_reason: 'Change species'
  });
  assert.equal(blocked.status, 400);
  assert.match(await blocked.text(), /separate identity-correction process/);
});

test('marking deceased requires Admin, CSRF, pet-name confirmation and preserves history', async () => {
  const admin = await login('1');
  const view = await get('/admin/pets/81/deceased', admin);
  assert.equal(view.response.status, 200);
  assert.match(view.html, /Owner/);
  assert.match(view.html, /does not deregister the pet with AVS\/PALS/);
  const historyBefore = petHistory.length;
  assert.equal((await post('/admin/pets/81/deceased', admin, {
    confirm_pet_name: 'Milo', confirm_deceased: 'yes'
  })).status, 403);
  assert.equal(pets.find(pet => pet.id === 81).status, 'active');
  const response = await post('/admin/pets/81/deceased', admin, {
    _csrf: 'token-1', confirm_pet_name: 'Milo Updated', confirm_deceased: 'yes'
  });
  assert.equal(response.status, 302);
  assert.equal(pets.find(pet => pet.id === 81).status, 'deceased');
  assert.equal(petHistory.length, historyBefore);
  const details = await get('/admin/users/7', admin);
  assert.match(details.html, /Deceased/);
  assert.doesNotMatch(details.html, /href="\/admin\/pets\/81\/deceased"/);
});
