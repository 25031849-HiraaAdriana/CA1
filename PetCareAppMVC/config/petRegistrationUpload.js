const multer = require('multer');

function fileFilter(req, file, callback) {
  if (file.fieldname === 'avs_licence_document' && file.mimetype !== 'application/pdf') {
    const error = new Error('AVS licence document must be a PDF');
    error.code = 'INVALID_AVS_DOCUMENT_TYPE';
    return callback(error);
  }
  return callback(null, true);
}

module.exports = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 2
  }
});
