const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const clinics = require('../data/veterinaryClinics');

test('curated directory has five emergency and six regular listings with complete contact actions', () => {
  assert.equal(clinics.filter(clinic => clinic.category === 'emergency').length, 5);
  assert.equal(clinics.filter(clinic => clinic.category === 'regular').length, 6);
  assert.equal(new Set(clinics.map(clinic => clinic.id)).size, clinics.length);

  clinics.forEach(clinic => {
    assert.ok(clinic.name);
    assert.match(clinic.phone, /^\+65 \d{4} \d{4}$/);
    assert.ok(clinic.address.includes('Singapore'));
    assert.match(clinic.website, /^https:\/\/[a-z\d.-]+\//i);
    assert.match(clinic.telephoneLink, /^\+65\d{8}$/);
    assert.equal(clinic.directionsUrl,
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(clinic.address)}`);
    assert.equal(new URL(clinic.directionsUrl).searchParams.get('destination'), clinic.address);
    assert.equal(clinic.verifiedOn, '2026-11-07');
    assert.equal(clinic.phoneVerified, undefined);
    assert.equal(clinic.addressVerified, undefined);
  });
});

test('supplied official contact corrections are reflected in the directory data', () => {
  const expected = {
    'beecroft-emergency': {
      phone: '+65 6996 1812',
      address: '991E Alexandra Road, #01-27, Singapore 119973',
      website: 'https://beecroft.com.sg/contact/'
    },
    'canopy-jurong': {
      phone: '+65 6980 8582',
      address: '1 Yuan Ching Road, #03-03, Singapore 618640',
      website: 'https://canopyvets.com/'
    },
    'atlas-bukit-merah': {
      phone: '+65 6980 8038',
      address: 'Blk 163 Bukit Merah Central, #03-3573, Singapore 150163',
      website: 'https://www.atlasvet.com.sg/directions/'
    },
    'pet-physician-bedok': {
      phone: '+65 6970 5267',
      address: '2 Jalan Pari Burong, Singapore 488668',
      website: 'https://www.thepetphysician.com.sg/'
    }
  };

  Object.entries(expected).forEach(([id, details]) => {
    const clinic = clinics.find(entry => entry.id === id);
    assert.ok(clinic, `${id} should be listed`);
    assert.equal(clinic.phone, details.phone);
    assert.equal(clinic.address, details.address);
    assert.equal(clinic.website, details.website);
    assert.equal(clinic.verificationNote, undefined);
  });
});

test('directory client and template contain only regional and service filters, with no GPS feature', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'veterinary-directory.js'),
    'utf8'
  );
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'veterinaryDirectory.ejs'),
    'utf8'
  );
  assert.match(script, /data-region-filter/);
  assert.match(script, /data-service-filter/);
  assert.doesNotMatch(script, /geolocation|latitude|longitude|distance|nearby/i);
  assert.doesNotMatch(template, /Find Vets Near Me|Use My Location|geolocation|nearby|data-latitude|data-longitude/i);

  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'veterinary-directory.css'),
    'utf8'
  );
  assert.doesNotMatch(css, /veterinary-nearby|veterinary-location|veterinary-distance/i);
});
