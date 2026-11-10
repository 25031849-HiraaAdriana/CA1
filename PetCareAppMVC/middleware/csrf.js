const { randomBytes, timingSafeEqual } = require('crypto');

function csrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  return next();
}

function csrfProtection(req, res, next) {
  const expected = req.session && req.session.csrfToken;
  const supplied = req.body && req.body._csrf;
  const expectedBuffer = typeof expected === 'string' ? Buffer.from(expected) : null;
  const suppliedBuffer = typeof supplied === 'string' ? Buffer.from(supplied) : null;
  if (
    !expectedBuffer ||
    !suppliedBuffer ||
    expectedBuffer.length !== suppliedBuffer.length ||
    !timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    return res.status(403).send('Invalid or missing CSRF token.');
  }
  return next();
}

function persistCsrfSession(req, res, next) {
  return req.session.save(error => {
    if (!error) return next();
    console.error('Authentication session could not be saved:', error.code || 'UNKNOWN');
    req.session = null;
    return res.status(503).send('Authentication is temporarily unavailable. Please try again later.');
  });
}

module.exports = { csrfToken, csrfProtection, persistCsrfSession };
