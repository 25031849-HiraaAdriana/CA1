function sessionErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  console.error('Session could not be loaded:', error.code || 'UNKNOWN');
  return res.status(503).send('The session service is temporarily unavailable. Please try again later.');
}

module.exports = sessionErrorHandler;
