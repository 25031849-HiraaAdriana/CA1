const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { csrfToken, csrfProtection, persistCsrfSession } = require('../middleware/csrf');
const { authenticationRateLimit } = require('../middleware/authRateLimit');

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  return next();
});

router.get('/signup', csrfToken, persistCsrfSession, authController.signupForm);
router.post('/signup', csrfProtection, authController.signup);
router.get('/login', csrfToken, persistCsrfSession, authController.loginForm);
router.post('/login', authenticationRateLimit, csrfProtection, authController.login);
router.post('/logout', csrfProtection, authController.logout);

module.exports = router;
