const connection = require('../config/db');
const adminActivityModel = require('./adminActivityModel');
const database = connection && typeof connection.promise === 'function'
  ? connection.promise()
  : null;
const createTransactionConnection = connection && connection.createPetShopTransactionConnection;

function createPet(ownerId, name, species, breed, age, avsLicenceNumber, microchipId, image, callback) {
  const duplicateError = { code: 'PET_IDENTIFIER_DUPLICATE' };
  const checkSql = 'SELECT id FROM pets WHERE avs_licence_number = ? OR microchip_id = ? LIMIT 1';

  connection.query(checkSql, [avsLicenceNumber, microchipId], (checkErr, pets) => {
    if (checkErr) return callback(checkErr);
    if (pets.length > 0) return callback(duplicateError);

    const insertSql = `
      INSERT INTO pets (
        owner_id, name, species, breed, age,
        avs_licence_number, microchip_id, image
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    connection.query(
      insertSql,
      [ownerId, name, species, breed, age, avsLicenceNumber, microchipId, image],
      (insertErr, result) => {
        if (insertErr && insertErr.code === 'ER_DUP_ENTRY') {
          return callback(duplicateError);
        }
        return callback(insertErr, result);
      }
    );
  });
}

function getPetsByOwner(ownerId, callback) {
  const sql = "SELECT * FROM pets WHERE owner_id = ? AND status = 'active' ORDER BY id";
  connection.query(sql, [ownerId], callback);
}

function getAllPetsByOwner(ownerId, callback) {
  const sql = 'SELECT * FROM pets WHERE owner_id = ? ORDER BY id';
  connection.query(sql, [ownerId], callback);
}

async function getPetById(petId) {
  if (!database) throw new Error('Database connection is unavailable.');
  const [pets] = await database.query(
    `SELECT p.*, u.name AS owner_name, u.username AS owner_username
     FROM pets p INNER JOIN users u ON u.id = p.owner_id
     WHERE p.id = ? LIMIT 1`,
    [petId]
  );
  return pets[0] || null;
}

async function withTransaction(callback) {
  if (typeof createTransactionConnection !== 'function') {
    throw new Error('A dedicated MySQL connection is required for Admin pet transactions.');
  }
  const transactionConnection = createTransactionConnection();
  const transactionDatabase = transactionConnection.promise();
  let transactionStarted = false;
  let committing = false;
  try {
    await transactionDatabase.connect();
    await transactionDatabase.beginTransaction();
    transactionStarted = true;
    const result = await callback(transactionDatabase);
    committing = true;
    await transactionDatabase.commit();
    transactionStarted = false;
    return result;
  } catch (error) {
    if (committing) error.commitOutcomeUnknown = true;
    if (transactionStarted && !committing) {
      try {
        await transactionDatabase.rollback();
      } catch (rollbackError) {
        error.commitOutcomeUnknown = true;
        console.error('Admin pet transaction rollback failed:', rollbackError.code || 'UNKNOWN');
      }
    }
    throw error;
  } finally {
    try {
      await transactionDatabase.end();
    } catch (endError) {
      console.error('Admin pet transaction connection close failed:', endError.code || 'UNKNOWN');
    }
  }
}

async function updatePetAsAdmin(petId, details, actor) {
  return withTransaction(async transactionDatabase => {
    const [pets] = await transactionDatabase.query(
      `SELECT p.*, u.name AS owner_name
       FROM pets p INNER JOIN users u ON u.id = p.owner_id
       WHERE p.id = ? LIMIT 1 FOR UPDATE`,
      [petId]
    );
    if (!pets.length) return null;
    const pet = pets[0];
    const identifiersChanged =
      (pet.avs_licence_number || null) !== details.avsLicenceNumber ||
      (pet.microchip_id || null) !== details.microchipId;

    const [duplicates] = await transactionDatabase.query(
      `SELECT id FROM pets
       WHERE id <> ? AND (
         (? IS NOT NULL AND avs_licence_number = ?) OR
         (? IS NOT NULL AND microchip_id = ?)
       ) LIMIT 1`,
      [
        petId,
        details.avsLicenceNumber, details.avsLicenceNumber,
        details.microchipId, details.microchipId
      ]
    );
    if (duplicates.length) {
      const error = new Error('An AVS licence number or Microchip ID is already registered.');
      error.code = 'PET_IDENTIFIER_DUPLICATE';
      throw error;
    }

    await transactionDatabase.query(
      `UPDATE pets
       SET name = ?, species = ?, breed = ?, age = ?, avs_licence_number = ?,
           microchip_id = ?, image = COALESCE(?, image)
       WHERE id = ?`,
      [
        details.name, details.species, details.breed, details.age,
        details.avsLicenceNumber, details.microchipId, details.image, petId
      ]
    );

    const auditId = await adminActivityModel.logAdminAction({
      adminId: Number(actor.id),
      adminUsername: actor.username,
      adminName: actor.name,
      actionType: identifiersChanged ? 'PET_IDENTIFIERS_CORRECTED' : 'PET_PROFILE_UPDATED',
      targetEntityType: 'pet',
      targetEntityId: petId,
      petId,
      petName: details.name,
      metadata: {
        changedFields: details.changedFields,
        ...(identifiersChanged ? {
          reason: details.correctionReason,
          oldIdentifiers: {
            avsLicenceNumber: pet.avs_licence_number || null,
            microchipId: pet.microchip_id || null
          },
          newIdentifiers: {
            avsLicenceNumber: details.avsLicenceNumber,
            microchipId: details.microchipId
          },
          documentMatchedLocally: details.documentMatchedLocally
        } : {})
      }
    }, transactionDatabase);
    if (!auditId) throw new Error('Admin pet update audit insertion failed.');
    return { ...pet, ...details, image: details.image || pet.image };
  });
}

async function markPetDeceased(petId, actor) {
  return withTransaction(async transactionDatabase => {
    const [pets] = await transactionDatabase.query(
      `SELECT p.id, p.name, p.status, p.owner_id, u.name AS owner_name
       FROM pets p INNER JOIN users u ON u.id = p.owner_id
       WHERE p.id = ? LIMIT 1 FOR UPDATE`,
      [petId]
    );
    if (!pets.length || pets[0].status !== 'active') return null;
    const pet = pets[0];
    const [updated] = await transactionDatabase.query(
      `UPDATE pets SET status = 'deceased' WHERE id = ? AND status = 'active'`,
      [petId]
    );
    if (updated.affectedRows !== 1) return null;
    const auditId = await adminActivityModel.logAdminAction({
      adminId: Number(actor.id),
      adminUsername: actor.username,
      adminName: actor.name,
      actionType: 'PET_MARKED_DECEASED',
      targetEntityType: 'pet',
      targetEntityId: petId,
      petId,
      petName: pet.name,
      metadata: {
        ownerId: pet.owner_id,
        ownerName: pet.owner_name,
        status: { old: 'active', new: 'deceased' },
        internalPomiActionOnly: true
      }
    }, transactionDatabase);
    if (!auditId) throw new Error('Pet archival audit insertion failed.');
    return pet;
  });
}

module.exports = {
  createPet,
  getPetsByOwner,
  getAllPetsByOwner,
  getPetById,
  updatePetAsAdmin,
  markPetDeceased
};
