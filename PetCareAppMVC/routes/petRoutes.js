const express = require('express');
const router = express.Router();
const upload = require('../config/petRegistrationUpload');
const { isLoggedIn, isPetOwner } = require('../middleware/auth');
const { csrfToken, csrfProtection } = require('../middleware/csrf');
const petController = require('../controllers/petController');
const userMedicalRecordController = require('../controllers/userMedicalRecordController');

function handlePetUploads(req, res, next) {
  upload.fields([
    { name: 'pet_image', maxCount: 1 },
    { name: 'avs_licence_document', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) return petController.handleUploadError(req, res, err);
    return next();
  });
}

router.get('/pets/new', isPetOwner, csrfToken, petController.newPetForm);
router.post('/pets', isPetOwner, csrfToken, handlePetUploads, csrfProtection, petController.createPet);
router.get('/pets/:id', isLoggedIn, petController.viewPet);
router.get(
  '/pets/:petId/medical-records',
  isPetOwner,
  userMedicalRecordController.listPetMedicalRecords
);
router.get(
  '/pets/:petId/medical-records/refill-requests',
  isPetOwner,
  userMedicalRecordController.listOwnerRefillRequests
);
router.get(
  '/pets/:petId/medical-records/:recordId',
  isPetOwner,
  csrfToken,
  userMedicalRecordController.viewPetMedicalRecord
);
router.get(
  '/pets/:petId/medical-records/:recordId/refill-requests/:medicationEntryId/new',
  isPetOwner,
  csrfToken,
  userMedicalRecordController.newOwnerRefillRequest
);
router.post(
  '/pets/:petId/medical-records/:recordId/refill-requests/:medicationEntryId/new',
  isPetOwner,
  csrfProtection,
  userMedicalRecordController.createOwnerRefillRequest
);
router.get(
  '/pets/:petId/medical-records/:recordId/document/preview',
  isPetOwner,
  userMedicalRecordController.previewOriginalDocument
);
router.get(
  '/pets/:petId/medical-records/:recordId/document/download',
  isPetOwner,
  userMedicalRecordController.downloadOriginalDocument
);

module.exports = router;
