const petModel = require('../models/petModel');
const journalModel = require('../models/journalModel');

// View All Journals
function listJournals(req, res) {
  const userId = req.session.user.id;
  let selectedPetId = req.query.petId;

  // Get all pets of this user
  petModel.getPetsByOwner(userId, (err, pets) => {
    if (err) return res.send('Error loading pets');

    // If no pet selected yet, default to first pet (if available)
    if (!selectedPetId && pets.length > 0) {
      selectedPetId = pets[0].id;
    }

    if (!selectedPetId) {
      // No pets at all
      return res.render('journals', {
        journals: [],
        pets,
        selectedPetId: '',
        pet: null,
        session: req.session
      });
    }

    journalModel.getJournalsByPetAndOwner(userId, selectedPetId, (err2, journals) => {
      if (err2) return res.send('Error loading journals');

      // Pet info always comes from the pets list
      const petInfo = pets.find(p => p.id == selectedPetId);

      return res.render('journals', {
        journals,
        pets,
        selectedPetId,
        pet: petInfo,
        session: req.session
      });
    });
  });
}

// New Journal Form
function newJournalForm(req, res) {
  const userId = req.session.user.id;
  const selectedPetId = req.query.petId; // Get optional petId from query

  petModel.getPetsByOwner(userId, (err, pets) => {
    if (err) return res.send('Error loading pets');

    res.render('newJournal', { pets, session: req.session, selectedPetId });
  });
}

// Handle New Journal Submission
function createJournal(req, res) {
  const { pet_id, activity, notes, entry_date } = req.body;

  journalModel.createJournal(pet_id, activity, notes, entry_date, (err) => {
    if (err) return res.send('Error saving journal');

    // Redirect to journals page and keep selected pet
    res.redirect(`/journals?petId=${pet_id}`);
  });
}

// Edit Journal Form
function editJournalForm(req, res) {
  const journalId = req.params.id;
  const userId = req.session.user.id;

  journalModel.getJournalById(journalId, (err, journalResults) => {
    if (err || journalResults.length === 0) return res.send('Journal not found');

    petModel.getPetsByOwner(userId, (err2, pets) => {
      if (err2) return res.send('Error fetching pets');

      res.render('editJournal', { journal: journalResults[0], pets, session: req.session });
    });
  });
}

// Handle Edit Submission
function updateJournal(req, res) {
  const { entry_date, activity, notes, pet_id } = req.body;
  const journalId = req.params.id;

  journalModel.updateJournal(journalId, entry_date, activity, notes, pet_id, (err) => {
    if (err) return res.send('Error updating journal');
    res.redirect(`/journals?petId=${pet_id}`); // 🔁 Redirect back to selected pet
  });
}

// Delete Journal
function deleteJournal(req, res) {
  const journalId = req.params.id;

  // First, find the pet_id for this journal
  journalModel.getPetIdForJournal(journalId, (err, result) => {
    if (err || result.length === 0) return res.send('Journal not found.');

    const petId = result[0].pet_id;

    // Now delete the journal
    journalModel.deleteJournal(journalId, (err2) => {
      if (err2) return res.send('Error deleting journal.');

      // Redirect to journals page for the correct pet
      res.redirect(`/journals?petId=${petId}`);
    });
  });
}

// Search Journals
function searchJournals(req, res) {
  const userId = req.session.user.id;
  const searchQuery = `%${req.query.q}%`;
  const selectedPetId = req.query.petId;

  petModel.getPetsByOwner(userId, (err, pets) => {
    if (err) return res.send('Error loading pets');

    journalModel.searchJournals(userId, searchQuery, selectedPetId, (err2, journals) => {
      if (err2) return res.send('Error searching journals');

      let pet = null;
      if (selectedPetId) {
        const found = pets.find(p => p.id.toString() === selectedPetId);
        if (found) pet = found;
      }

      res.render('journals', {
        journals,
        pets,
        selectedPetId,
        pet,
        session: req.session
      });
    });
  });
}

module.exports = {
  listJournals,
  newJournalForm,
  createJournal,
  editJournalForm,
  updateJournal,
  deleteJournal,
  searchJournals
};
