const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 2,
    fields: 12,
    parts: 14,
    fieldSize: 2000
  },
  fileFilter(req, file, callback) {
    const allowed = file.fieldname === 'pet_image'
      ? ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)
      : file.fieldname === 'avs_licence_document' && file.mimetype === 'application/pdf';
    if (allowed) return callback(null, true);

    const error = new Error(file.fieldname === 'pet_image'
      ? 'Pet photos must be JPEG, PNG or WebP files.'
      : 'The AVS licence document must be a PDF.');
    error.code = file.fieldname === 'pet_image'
      ? 'INVALID_PET_IMAGE_TYPE'
      : 'INVALID_AVS_DOCUMENT_TYPE';
    return callback(error);
  }
});

module.exports = upload;
