const connection = require('../config/db');

function getJournalsByOwner(ownerId, callback) {
  const sql = `
    SELECT journal.*, pets.id AS pet_id
    FROM journal
    JOIN pets ON journal.pet_id = pets.id
    WHERE pets.owner_id = ? AND pets.status = 'active'
  `;
  connection.query(sql, [ownerId], callback);
}

function getJournalsByPetAndOwner(ownerId, petId, callback) {
  const sql = `
    SELECT journal.*, pets.name, pets.species, pets.breed, pets.age, pets.image 
    FROM journal 
    JOIN pets ON journal.pet_id = pets.id 
    WHERE pets.owner_id = ? AND pets.id = ? AND pets.status = 'active'
  `;
  connection.query(sql, [ownerId, petId], callback);
}

function getJournalById(journalId, callback) {
  const sql = `SELECT j.* FROM journal j
    INNER JOIN pets p ON p.id = j.pet_id
    WHERE j.id = ? AND p.status = 'active'`;
  connection.query(sql, [journalId], callback);
}

function createJournal(petId, activity, notes, entryDate, callback) {
  const sql = `INSERT INTO journal (pet_id, activity, notes, entry_date)
    SELECT id, ?, ?, ? FROM pets WHERE id = ? AND status = 'active'`;
  connection.query(sql, [activity, notes, entryDate, petId], (error, result) => {
    if (error) return callback(error);
    if (!result.affectedRows) {
      const inactivePetError = new Error('The pet is not active.');
      inactivePetError.code = 'PET_NOT_ACTIVE';
      return callback(inactivePetError);
    }
    return callback(null, result);
  });
}

function updateJournal(journalId, entryDate, activity, notes, petId, callback) {
  const sql = `UPDATE journal j INNER JOIN pets p ON p.id = ?
    SET j.entry_date = ?, j.activity = ?, j.notes = ?, j.pet_id = ?
    WHERE j.id = ? AND p.status = 'active'`;
  connection.query(sql, [petId, entryDate, activity, notes, petId, journalId], callback);
}

function getPetIdForJournal(journalId, callback) {
  const sql = `SELECT j.pet_id FROM journal j
    INNER JOIN pets p ON p.id = j.pet_id
    WHERE j.id = ? AND p.status = 'active'`;
  connection.query(sql, [journalId], callback);
}

function deleteJournal(journalId, callback) {
  const sql = `DELETE j FROM journal j
    INNER JOIN pets p ON p.id = j.pet_id
    WHERE j.id = ? AND p.status = 'active'`;
  connection.query(sql, [journalId], callback);
}

function searchJournals(ownerId, searchQuery, selectedPetId, callback) {
  let sql = `
    SELECT journal.*, pets.name, pets.species, pets.breed, pets.age, pets.image 
    FROM journal 
    JOIN pets ON journal.pet_id = pets.id 
    WHERE pets.owner_id = ? AND pets.status = 'active'
      AND (journal.activity LIKE ? OR journal.notes LIKE ?)`

  const params = [ownerId, searchQuery, searchQuery];

  if (selectedPetId) {
    sql += ' AND pets.id = ?';
    params.push(selectedPetId);
  }

  connection.query(sql, params, callback);
}

module.exports = {
  getJournalsByOwner,
  getJournalsByPetAndOwner,
  getJournalById,
  createJournal,
  updateJournal,
  getPetIdForJournal,
  deleteJournal,
  searchJournals
};
