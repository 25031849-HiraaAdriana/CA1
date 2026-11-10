const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 10
  },
  fileFilter(req, file, callback) {
    if (file.fieldname === 'images' &&
        ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(null, true);
    }
    if (file.fieldname === 'supporting_documents' && file.mimetype === 'application/pdf') {
      return callback(null, true);
    }
    if (file.fieldname === 'images') {
      const error = new Error('Product images must be JPEG, PNG or WebP files.');
      error.code = 'INVALID_PRODUCT_IMAGE_TYPE';
      return callback(error);
    }
    const error = new Error('Product supporting documents must be PDF files.');
    error.code = 'INVALID_PRODUCT_DOCUMENT_TYPE';
    return callback(error);
  }
});

module.exports = upload;
