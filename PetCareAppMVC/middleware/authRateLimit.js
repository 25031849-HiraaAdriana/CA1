const rateLimit = require('express-rate-limit');

const authenticationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: 'Too many authentication attempts. Try again later.'
});

module.exports = { authenticationRateLimit };
