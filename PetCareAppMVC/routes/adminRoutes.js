const express = require('express');
const path = require('path');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');
const adminController = require('../controllers/adminController');
const adminActivityController = require('../controllers/adminActivityController');
const medicalRecordController = require('../controllers/medicalRecordController');
const medicationRefillController = require('../controllers/medicationRefillController');
const { uploadMedicalDocument, uploadMedicalDocumentForPublication } = require('../config/medicalRecordUpload');
const adminPetUpload = require('../config/adminPetUpload');
const productImageUpload = require('../config/productImageUpload');
const petShopController = require('../controllers/petShopController');
const { csrfToken, csrfProtection } = require('../middleware/csrf');

router.get('/admin/dashboard', isAdmin, adminController.dashboard);
router.get('/admin/activity-history', isAdmin, adminActivityController.listActivityHistory);
router.get('/admin/products', isAdmin, petShopController.listAdminProducts);
router.get('/admin/products/:id/documents/:documentId', isAdmin, petShopController.downloadProductDocument);
router.get('/admin/products/new', isAdmin, csrfToken, petShopController.newProductForm);
router.post(
  '/admin/products',
  isAdmin,
  (req, res, next) => {
    productImageUpload.fields([
      { name: 'images', maxCount: 5 },
      { name: 'supporting_documents', maxCount: 5 }
    ])(req, res, error => {
      if (error) return petShopController.handleImageUploadError(req, res, error);
      return next();
    });
  },
  csrfProtection,
  petShopController.saveProduct
);
router.get('/admin/products/:id/edit', isAdmin, csrfToken, petShopController.editProductForm);
router.post(
  '/admin/products/:id',
  isAdmin,
  (req, res, next) => {
    productImageUpload.fields([
      { name: 'images', maxCount: 5 },
      { name: 'supporting_documents', maxCount: 5 }
    ])(req, res, error => {
      if (error) return petShopController.handleImageUploadError(req, res, error);
      return next();
    });
  },
  csrfProtection,
  petShopController.saveProduct
);
router.get('/admin/users', isAdmin, csrfToken, adminController.listUsers);
router.get('/admin/users/:id/edit', isAdmin, csrfToken, adminController.editUserForm);
router.post('/admin/users/:id/edit', isAdmin, csrfProtection, adminController.updateUser);
router.get('/admin/users/:id/delete', isAdmin, csrfToken, adminController.confirmDeleteUser);
router.post('/admin/users/:id/delete', isAdmin, csrfProtection, adminController.deleteUser);
router.get('/admin/users/delete/:id', isAdmin, (req, res) => {
  res.redirect(`/admin/users/${encodeURIComponent(req.params.id)}/delete`);
});
router.get('/admin/users/:id', isAdmin, csrfToken, adminController.viewUserDetails);
router.get('/admin/pets/:id/edit', isAdmin, csrfToken, adminController.editPetForm);
router.post('/admin/pets/:id/edit', isAdmin, (req, res, next) => {
  adminPetUpload.fields([
    { name: 'pet_image', maxCount: 1 },
    { name: 'avs_licence_document', maxCount: 1 }
  ])(req, res, error => {
    if (error) return adminController.handlePetUploadError(req, res, error);
    return next();
  });
}, csrfProtection, adminController.updatePet);
router.get('/admin/pets/:id/deceased', isAdmin, csrfToken, adminController.deceasedConfirmation);
router.post('/admin/pets/:id/deceased', isAdmin, csrfProtection, adminController.markPetDeceased);
router.get('/admin/pets/:id', isAdmin, adminController.viewPet);
router.get('/admin/medical-records', isAdmin, csrfToken, medicalRecordController.listManagement);
const pdfPreviewBuild = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'build');
router.get('/admin/medical-preview/pdf.mjs', isAdmin, (req, res) => res.sendFile(path.join(pdfPreviewBuild, 'pdf.mjs')));
router.get('/admin/medical-preview/pdf.worker.mjs', isAdmin, (req, res) => res.sendFile(path.join(pdfPreviewBuild, 'pdf.worker.mjs')));
router.get(
  '/admin/refill-requests',
  isAdmin,
  csrfToken,
  medicationRefillController.listAdminRefillRequests
);
router.post(
  '/admin/refill-requests/:requestId/review',
  isAdmin,
  csrfProtection,
  medicationRefillController.reviewAdminRefillRequest
);
router.get('/admin/medical-records/new', isAdmin, (req, res) => {
  const petId = typeof req.query.petId === 'string' ? req.query.petId : '';
  res.redirect(`/admin/medical-records${petId ? `?petId=${encodeURIComponent(petId)}` : ''}`);
});
router.post(
  '/admin/medical-records/publish',
  isAdmin,
  (req, res, next) => {
    req.newPublication = true;
    uploadMedicalDocumentForPublication.single('medical_document')(req, res, error => {
      if (error) return medicalRecordController.handleUploadError(req, res, error);
      return next();
    });
  },
  csrfProtection,
  medicalRecordController.publishNewRecord
);
router.post(
  '/admin/medical-records',
  isAdmin,
  (req, res, next) => {
    uploadMedicalDocument.single('medical_document')(req, res, error => {
      if (error) return medicalRecordController.handleUploadError(req, res, error);
      return next();
    });
  },
  csrfProtection,
  medicalRecordController.createDraft
);
router.get(
  '/admin/medical-records/:id/document/preview',
  isAdmin,
  medicalRecordController.previewOriginalDocument
);
router.get(
  '/admin/medical-records/:id/document/download',
  isAdmin,
  medicalRecordController.downloadOriginalDocument
);
router.get(
  '/admin/medical-records/:id/review',
  isAdmin,
  csrfToken,
  medicalRecordController.reviewDraft
);
router.post(
  '/admin/medical-records/:id/review',
  isAdmin,
  csrfProtection,
  medicalRecordController.updateDraftReview
);

module.exports = router;
