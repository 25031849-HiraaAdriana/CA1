const assert = require('node:assert/strict');
const { test } = require('node:test');

const calls = [];
let currentPet;
let duplicateRows = [];
let committed = 0;
let rolledBack = 0;
let insertedAudit = 0;

const transactionDatabase = {
  connect: async () => {},
  beginTransaction: async () => {},
  commit: async () => { committed += 1; },
  rollback: async () => { rolledBack += 1; },
  end: async () => {},
  query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (/SELECT p\.\*, u\.name AS owner_name/.test(sql)) {
      return [currentPet ? [{ ...currentPet }] : []];
    }
    if (/SELECT p\.id, p\.name, p\.status/.test(sql)) {
      return [currentPet ? [{
        id: currentPet.id, name: currentPet.name, status: currentPet.status,
        owner_id: currentPet.owner_id, owner_name: currentPet.owner_name
      }] : []];
    }
    if (/SELECT id FROM pets/.test(sql)) return [duplicateRows];
    if (/INSERT INTO admin_activity_logs/.test(sql)) return [{ insertId: ++insertedAudit }];
    if (/UPDATE pets/.test(sql)) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL in test: ${sql}`);
  }
};

const connection = {
  query(sql, params, callback) {
    calls.push({ sql, params });
    callback(null, []);
  },
  promise: () => transactionDatabase,
  createPetShopTransactionConnection: () => ({ promise: () => transactionDatabase })
};
const connectionPath = require.resolve('../config/db');
require.cache[connectionPath] = {
  id: connectionPath, filename: connectionPath, loaded: true, children: [], paths: [], exports: connection
};
const petModel = require('../models/petModel');

function reset(pet = {}) {
  calls.length = 0;
  committed = 0;
  rolledBack = 0;
  duplicateRows = [];
  currentPet = {
    id: 8,
    owner_id: 7,
    owner_name: 'Owner',
    name: 'Milo',
    species: 'Dog',
    breed: 'Shiba Inu',
    age: 4,
    avs_licence_number: 'AVS-123',
    microchip_id: 'MID-456',
    image: 'milo.jpg',
    status: 'active',
    ...pet
  };
}

test('active owner pet listings exclude deceased pets while Admin gets the full owner history', () => {
  reset();
  petModel.getPetsByOwner(7, () => {});
  assert.match(calls.at(-1).sql, /owner_id = \? AND status = 'active'/);
  petModel.getAllPetsByOwner(7, () => {});
  assert.doesNotMatch(calls.at(-1).sql, /status\s*=/);
  assert.match(calls.at(-1).sql, /owner_id = \?/);
});

test('Admin pet updates audit identifier corrections without changing ownership or status', async () => {
  reset();
  const updated = await petModel.updatePetAsAdmin(8, {
    name: 'Milo',
    species: 'Dog',
    breed: 'Shiba Inu',
    age: 4,
    avsLicenceNumber: 'AVS-789',
    microchipId: 'MID-999',
    image: null,
    changedFields: ['identifiers'],
    correctionReason: 'Corrected from current licence',
    documentMatchedLocally: true
  }, { id: 1, username: 'admin', name: 'Admin' });
  const updateCall = calls.find(call => /UPDATE pets/.test(call.sql));
  const auditCall = calls.find(call => /INSERT INTO admin_activity_logs/.test(call.sql));
  assert.ok(updateCall);
  assert.doesNotMatch(updateCall.sql, /owner_id|status\s*=/);
  assert.equal(updated.owner_id, 7);
  assert.equal(updated.status, 'active');
  assert.ok(auditCall);
  const metadata = JSON.parse(auditCall.params[11]);
  assert.equal(auditCall.params[3], 'PET_IDENTIFIERS_CORRECTED');
  assert.deepEqual(metadata.oldIdentifiers, { avsLicenceNumber: 'AVS-123', microchipId: 'MID-456' });
  assert.deepEqual(metadata.newIdentifiers, { avsLicenceNumber: 'AVS-789', microchipId: 'MID-999' });
  assert.equal(metadata.reason, 'Corrected from current licence');
  assert.equal(metadata.documentMatchedLocally, true);
  assert.equal(committed, 1);
  assert.equal(rolledBack, 0);
});

test('duplicate pet identity values roll back the profile edit and audit', async () => {
  reset();
  duplicateRows = [{ id: 9 }];
  await assert.rejects(
    petModel.updatePetAsAdmin(8, {
      name: 'Milo', species: 'Dog', breed: 'Shiba Inu', age: 4,
      avsLicenceNumber: 'AVS-123', microchipId: 'MID-999', image: null,
      changedFields: ['identifiers'], correctionReason: 'Correction',
      documentMatchedLocally: true
    }, { id: 1, username: 'admin', name: 'Admin' }),
    error => error.code === 'PET_IDENTIFIER_DUPLICATE'
  );
  assert.equal(calls.some(call => /UPDATE pets/.test(call.sql)), false);
  assert.equal(calls.some(call => /INSERT INTO admin_activity_logs/.test(call.sql)), false);
  assert.equal(committed, 0);
  assert.equal(rolledBack, 1);
});

test('deceased status is an audited status-only update and retains existing history references', async () => {
  reset();
  const pet = await petModel.markPetDeceased(8, { id: 1, username: 'admin', name: 'Admin' });
  const updateCall = calls.find(call => /UPDATE pets/.test(call.sql));
  const auditCall = calls.find(call => /INSERT INTO admin_activity_logs/.test(call.sql));
  assert.equal(pet.owner_id, 7);
  assert.equal(updateCall.sql.trim(), "UPDATE pets SET status = 'deceased' WHERE id = ? AND status = 'active'");
  assert.equal(calls.some(call => /DELETE|medical_records|appointments|medication_refill_requests/.test(call.sql)), false);
  assert.equal(auditCall.params[3], 'PET_MARKED_DECEASED');
  assert.equal(JSON.parse(auditCall.params[11]).internalPomiActionOnly, true);
  assert.equal(committed, 1);
  assert.equal(rolledBack, 0);
});

test('deceased transition is idempotently refused for an already-inactive pet', async () => {
  reset({ status: 'deceased' });
  const result = await petModel.markPetDeceased(8, { id: 1, username: 'admin', name: 'Admin' });
  assert.equal(result, null);
  assert.equal(calls.some(call => /UPDATE pets|INSERT INTO admin_activity_logs/.test(call.sql)), false);
  assert.equal(committed, 1);
});
