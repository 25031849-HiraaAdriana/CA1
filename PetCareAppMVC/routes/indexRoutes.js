const express = require('express');
const router = express.Router();
const { isLoggedIn, isPetOwner } = require('../middleware/auth');
const { csrfToken } = require('../middleware/csrf');
const indexController = require('../controllers/indexController');

router.get('/', indexController.index);
router.get('/dashboard', isLoggedIn, isPetOwner, csrfToken, indexController.dashboard);

module.exports = router;
