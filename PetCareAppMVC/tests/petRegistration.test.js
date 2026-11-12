const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { before, after, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const { syntheticLicencePdf } = require('./support/syntheticLicencePdf');

function mock(module, exports) {
  const resolved = require.resolve(module);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, children: [], paths: [], exports };
}

const pets = [];
let raceDuplicate = false;
let lookups = 0;
mock('../config/db', {
  query(sql, params, callback) {
    if (sql.includes('SELECT * FROM pets')) {
      return callback(null, pets.filter(pet => pet.ownerId === params));
    }
    if (sql.includes('SELECT id FROM pets')) {
      lookups += 1;
      return callback(null, pets.filter(pet =>
        (params[0] !== null && pet.avs === params[0]) ||
        (params[1] !== null && pet.chip === params[1])));
    }
    if (raceDuplicate) {
      raceDuplicate = false;
      return callback({ code: 'ER_DUP_ENTRY' });
    }
    const [ownerId, name, species, breed, age, avs, chip, image] = params;
    pets.push({ id: pets.length + 1, ownerId, name, species, breed, age, avs, chip, image });
    return callback(null, { insertId: pets.length });
  }
});
mock('../controllers/userMedicalRecordController', {
  listPetMedicalRecords() {}, listOwnerRefillRequests() {}, viewPetMedicalRecord() {},
  newOwnerRefillRequest() {}, createOwnerRefillRequest() {}, previewOriginalDocument() {},
  downloadOriginalDocument() {}
});

let server;
let base;
let user;
let otherUser;
let admin;
before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(session({ secret: 'offline-registration-tests', resave: false, saveUninitialized: false }));
  app.get('/test-login/:role/:id', (req, res) => {
    req.session.user = { id: Number(req.params.id), role: req.params.role, name: 'Test' };    req.session.csrfToken = `token-${req.params.id}`;
    res.sendStatus(204);
  });
  app.use(require('../routes/petRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  async function login(role, id) {
    const response = await fetch(`${base}/test-login/${role}/${id}`);
    return response.headers.get('set-cookie').split(';', 1)[0];
  }
  user = await login('user', 7);
  otherUser = await login('user', 8);
  admin = await login('admin', 9);
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

function licencePdf(identifiers) {
  const [avs, chip, name = 'Milo', section = 'Dog Particulars'] = identifiers.split('|');
  const lines = [
    'Licensee Particulars', 'Name: Synthetic Owner',
    section, `Name: ${name}`, `Microchip No.: ${chip}`, 'Breed: Mixed',
    'Colour: Brown', 'Sex: Female', 'Licence Info', `Licence No.: ${avs}`,
    'Issue Date: 01/01/2025', 'Expiry Date: 01/01/2026'
  ];
  return pdfFromLines(lines);
}

function pdfFromLines(lines) {
  const content = `BT /F1 12 Tf 40 700 Td ${lines.map(line =>
    `(${line.replace(/[\\()]/g, '\\$&')}) Tj 0 -24 Td`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

function form(fields, document, token = 'token-7') {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    _csrf: token, pet_name: 'Milo', species: 'Dog', breed: 'Mixed', age: '3', ...fields
  })) data.append(key, value);
  if (document !== undefined) {
    const bytes = typeof document === 'string' && document.includes('|') ? licencePdf(document) : document;
    data.append('avs_licence_document', new Blob([bytes], { type: 'application/pdf' }), 'licence.pdf');
  }
  return data;
}
async function post(data, cookie = user) {
  const response = await fetch(`${base}/pets`, { method: 'POST', headers: { Cookie: cookie }, body: data, redirect: 'manual' });
  return { status: response.status, text: await response.text() };
}

test('form requires a user and contains a CSRF token and species before microchip', async () => {
  const response = await fetch(`${base}/pets/new`, { headers: { Cookie: user } });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /name="_csrf" value="token-7"/);
  assert.ok(html.indexOf('name="species"') < html.indexOf('name="microchip_id"'));
  assert.match(html, /Does your pet have a microchip/);
  for (const cookie of [admin, '']) {
    const result = await fetch(`${base}/pets/new`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(result.status, 302);
  }
});

test('dog and cat require both identifiers and a matching locally checked PDF', async () => {
  for (const species of ['Dog', 'Cat']) {
    const chip = species === 'Dog' ? '900000000000001' : '900000000000002';
    const avs = `${species}-avs1`;
    assert.equal((await post(form({ species, microchip_id: chip, avs_licence_number: avs }))).status, 400);
    assert.equal((await post(form({ species, microchip_id: chip, avs_licence_number: '' }, `${avs}|${chip}`))).status, 400);
    assert.equal((await post(form({ species, microchip_id: '', avs_licence_number: avs }, `${avs}|${chip}`))).status, 400);
    assert.equal((await post(form({ species, microchip_id: chip, avs_licence_number: avs }, 'unreadable'))).status, 400);
    assert.equal((await post(form({ species, microchip_id: chip, avs_licence_number: avs }, `${avs}|900000000000009`))).status, 400);
    const result = await post(form({ species, microchip_id: chip, avs_licence_number: avs }, `${avs}|${chip}|Milo|${species} Particulars`));
    assert.equal(result.status, 200);
    assert.match(result.text, /Pet Registered Successfully/);
    assert.equal(pets.at(-1).ownerId, 7);
    assert.equal(pets.at(-1).chip, chip);
  }
});

test('document checks name and both distinct identifiers independently', async () => {
  const fields = { pet_name: 'Milo', microchip_id: '000000000001234', avs_licence_number: '0009876' };
  for (const [changes, pdf, message] of [
    [{ pet_name: 'Other' }, '0009876|000000000001234', /pet name/i],
    [{ pet_name: 'Synthetic Owner' }, '0009876|000000000001234', /pet name/i],
    [{ microchip_id: '000000000001235' }, '0009876|000000000001234', /Microchip ID/i],
    [{ avs_licence_number: '0009877' }, '0009876|000000000001234', /AVS licence number/i],
    [{ avs_licence_number: '000000000001234' }, '000000000001234|000000000001234', /must be different/i],
    [{}, '0009876|000000000001234|', /missing, ambiguous or unreadable.*pet name/i]
  ]) {
    const result = await post(form({ ...fields, ...changes }, pdf));
    assert.equal(result.status, 400);
    assert.match(result.text, message);
  }
  const result = await post(form({ ...fields, pet_name: '  mILO  ' }, '0009876|000000000001234|Milo'));
  assert.equal(result.status, 200);
  assert.equal(pets.at(-1).name, 'mILO');
  assert.equal(pets.at(-1).chip, '000000000001234');
  assert.equal(pets.at(-1).avs, '0009876');
});

test('validates MID format on the document path without changing entered values', async () => {
  const fields = { pet_name: 'Milo', microchip_id: '900000000000321', avs_licence_number: 'LIC-321' };
  for (const chip of ['90000000000032', '9000000000003210', '90000000000032A',
    '900000000000 321', '900000000000-321', ' 900000000000321', '900000000000321 ']) {
    const result = await post(form({ ...fields, microchip_id: chip }, `LIC-321|900000000000321`));
    assert.equal(result.status, 400, chip);
    assert.match(result.text, /Microchip ID must contain exactly 15 digits/);
    assert.ok(result.text.includes(`value="${chip}"`));
  }
  const result = await post(form(fields, 'LIC-321|900000000000321|Milo|Animal Details'));
  assert.equal(result.status, 200);
  assert.equal(pets.at(-1).chip, '900000000000321');
});

test('supports generic pet PDF sections on existing document-required paths', async () => {
  const fields = { species: 'Cat', microchip_id: '900000000000322', avs_licence_number: 'LIC-322' };
  const result = await post(form(fields, 'LIC-322|900000000000322|Milo|Pet Particulars'));
  assert.equal(result.status, 200);
  const lettersOnly = await post(form({ ...fields, microchip_id: '900000000000323', avs_licence_number: 'ABCDEF' },
    'ABCDEF|900000000000323|Milo|Animal Information'));
  assert.equal(lettersOnly.status, 200);
});

test('registers from a multi-page aligned-table PDF and rejects mismatches', async () => {
  const pdf = syntheticLicencePdf([
    [
      { x: 40, y: 740, text: 'Pet Details' },
      { x: 40, y: 720, text: 'Name' }, { x: 230, y: 720, text: 'Microchip No.' },
      { x: 40, y: 700, text: 'Amber' }, { x: 230, y: 700, text: '001234567890123' },
      { x: 40, y: 680, text: 'Owner Details' }, { x: 40, y: 660, text: 'Name: Synthetic Owner' }
    ],
    [
      { x: 40, y: 740, text: 'Licence Details' },
      { x: 40, y: 720, text: 'Licence No.' }, { x: 230, y: 720, text: 'Issue Date' },
      { x: 40, y: 700, text: 'XY-0012' }, { x: 230, y: 700, text: '01/01/2025' }
    ]
  ]);
  const fields = { species: 'Cat', pet_name: 'Amber', microchip_id: '001234567890123', avs_licence_number: 'XY-0012' };
  for (const [changes, error] of [
    [{ pet_name: 'Synthetic Owner' }, /pet name/i],
    [{ microchip_id: '001234567890124' }, /Microchip ID/i],
    [{ avs_licence_number: 'XY-0013' }, /AVS licence number/i]
  ]) {
    const result = await post(form({ ...fields, ...changes }, pdf));
    assert.equal(result.status, 400);
    assert.match(result.text, error);
    assert.match(result.text, /does not match/i);
  }
  assert.equal((await post(form(fields, pdf))).status, 200);
});

test('shows an explicit unsupported message for image-only PDFs', async () => {
  const result = await post(form({
    pet_name: 'Amber', microchip_id: '001234567890124', avs_licence_number: 'XY-0013'
  }, syntheticLicencePdf([null])));
  assert.equal(result.status, 400);
  assert.match(result.text, /Scanned or image-only PDF pages are not supported/);
});

test('rejects missing and ambiguous section fields in uploaded PDFs', async () => {
  const fields = { microchip_id: '000000000003333', avs_licence_number: '009999' };
  const dog = ['Dog Particulars', 'Name: Milo', 'Microchip No.: 000000000003333', 'Breed: Mixed'];
  const licence = ['Licence Info', 'Licence No.: 009999', 'Issue Date: 01/01/2025'];
  const documents = [
    [['Dog Particulars', 'Microchip No.: 000000000003333', 'Breed: Mixed'], licence, /pet name/i],
    [[...dog, 'Name: Other'], licence, /pet name/i],
    [['Dog Particulars', 'Name: Milo', 'Breed: Mixed'], licence, /Microchip ID/i],
    [[...dog, 'Microchip No.: 000000000004444'], licence, /Microchip ID/i],
    [dog, ['Licence Info', 'Issue Date: 01/01/2025'], /AVS licence number/i],
    [dog, [...licence, 'Licence No.: 008888'], /AVS licence number/i]
  ];
  for (const [dogSection, licenceSection, missing] of documents) {
    const pdf = pdfFromLines(['Licensee Particulars', 'Name: Synthetic Owner', ...dogSection, ...licenceSection]);
    const result = await post(form(fields, pdf));
    assert.equal(result.status, 400);
    assert.match(result.text, /missing, ambiguous or unreadable/i);
    assert.match(result.text, missing);
  }
});

test('existing null identifiers remain unchanged after registration', async () => {
  const legacy = { id: 1000, ownerId: 7, name: 'Legacy', avs: null, chip: null };
  pets.push(legacy);
  const result = await post(form({ species: 'Rabbit', has_microchip: 'no' }));
  assert.equal(result.status, 200);
  assert.deepEqual(legacy, { id: 1000, ownerId: 7, name: 'Legacy', avs: null, chip: null });
});

test('each eligible species supports NULL identifiers or a real microchip', async () => {
  for (const species of ['Rabbit', 'Hamster', 'Guinea Pig']) {
    let result = await post(form({ species, has_microchip: 'no' }));
    assert.equal(result.status, 200);
    assert.equal(pets.at(-1).chip, null);
    assert.equal(pets.at(-1).avs, null);
    result = await post(form({ species: species.toLowerCase(), has_microchip: 'yes', microchip_id: `real-${species.replace(' ', '')}-1` }));
    assert.equal(result.status, 200);
    assert.equal(pets.at(-1).species, species);
    assert.equal(pets.at(-1).chip, `real-${species.replace(' ', '')}-1`);
    assert.equal(pets.at(-1).avs, null);
  }
});

test('rejects unknown species, inconsistent choices and invalid fields', async () => {
  for (const fields of [
    { species: 'ferret', has_microchip: 'no' },
    { species: 'dogs', has_microchip: 'no' },
    { species: '__proto__', has_microchip: 'no' },
    { species: 'Rabbit' },
    { species: 'Rabbit', has_microchip: 'yes' },
    { species: 'Rabbit', has_microchip: 'no', microchip_id: 'CHIP' },
    { species: 'Rabbit', has_microchip: 'yes', microchip_id: 'x'.repeat(31) },
    { species: 'Rabbit', has_microchip: 'yes', microchip_id: 'not a number' },
    { species: 'Rabbit', has_microchip: 'no', avs_licence_number: 'AVS' },
    { species: 'Rabbit', has_microchip: 'no', age: '-1' },
    { species: 'Rabbit', has_microchip: 'no', pet_name: ' ' }
  ]) {
    assert.equal((await post(form(fields))).status, 400, JSON.stringify(fields));
  }
  assert.equal((await post(form({ species: 'Rabbit', has_microchip: 'no' }, 'unused'))).status, 400);
});

test('duplicate checks cover either identifier and concurrent unique-index errors', async () => {
  assert.equal((await post(form({ species: 'Rabbit', has_microchip: 'yes', microchip_id: '900000000000001' }))).status, 409);
  assert.equal((await post(form({ species: 'Dog', microchip_id: '900000000000010', avs_licence_number: 'Dog-avs1' }, 'Dog-avs1|900000000000010'))).status, 409);
  assert.equal((await post(form({ species: 'Dog', microchip_id: '900000000000001', avs_licence_number: 'new-avs1' }, 'new-avs1|900000000000001'))).status, 409);
  raceDuplicate = true;
  assert.equal((await post(form({ species: 'Rabbit', has_microchip: 'no' }))).status, 409);
});

test('CSRF, user role and owner-scoped profiles prevent cross-user actions', async () => {
  const beforeLookups = lookups;
  assert.equal((await post(form({ species: 'Rabbit', has_microchip: 'no' }, undefined, 'wrong'))).status, 403);
  assert.equal((await post(form({ species: 'Rabbit', has_microchip: 'no' }, undefined, 'token-9'), admin)).status, 302);
  assert.equal((await post(form({ species: 'Rabbit', has_microchip: 'no' }), '')).status, 302);
  assert.equal(lookups, beforeLookups);
  const response = await fetch(`${base}/pets/1`, { headers: { Cookie: otherUser }, redirect: 'manual' });
  assert.equal(response.status, 404);
});

test('pet photos are stored only after successful CSRF and are cleaned up on duplicate', async () => {
  const directory = path.join(__dirname, '..', 'public', 'images');
  const before = new Set(await fs.readdir(directory));
  const invalid = form({ species: 'Rabbit', has_microchip: 'no' }, undefined, 'wrong');
  invalid.append('pet_image', new Blob(['image bytes'], { type: 'image/png' }), 'pet.png');
  assert.equal((await post(invalid)).status, 403);
  const afterInvalid = await fs.readdir(directory);
  assert.equal(afterInvalid.filter(name => !before.has(name)).length, 0);

  const valid = form({ species: 'Rabbit', has_microchip: 'no' });
  valid.append('pet_image', new Blob(['image bytes'], { type: 'image/png' }), 'pet.png');
  assert.equal((await post(valid)).status, 200);
  const imagePath = path.join(directory, pets.at(-1).image);
  try {
    assert.equal(await fs.readFile(imagePath, 'utf8'), 'image bytes');
  } finally {
    await fs.unlink(imagePath);
  }

  const duplicate = form({ species: 'Rabbit', has_microchip: 'yes', microchip_id: '900000000000001' });
  duplicate.append('pet_image', new Blob(['image bytes'], { type: 'image/png' }), 'pet.png');
  assert.equal((await post(duplicate)).status, 409);
  const afterDuplicate = await fs.readdir(directory);
  assert.equal(afterDuplicate.filter(name => !before.has(name)).length, 0);
});
