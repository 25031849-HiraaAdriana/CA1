const multer = require('multer');

const MAX_MEDICAL_DOCUMENT_SIZE = 10 * 1024 * 1024;

const uploadMedicalDocument = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_MEDICAL_DOCUMENT_SIZE + 1,
    files: 1,
    fields: 7,
    // Busboy emits its limit at the boundary, so allow one beyond each maximum.
    parts: 9,
    fieldSize: 60001
  }
});

const uploadMedicalDocumentForPublication = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_MEDICAL_DOCUMENT_SIZE + 1,
    files: 1,
    fields: 62,
    parts: 64,
    fieldSize: 410000
  }
});

module.exports = {
  uploadMedicalDocument,
  uploadMedicalDocumentForPublication,
  MAX_MEDICAL_DOCUMENT_SIZE
};
