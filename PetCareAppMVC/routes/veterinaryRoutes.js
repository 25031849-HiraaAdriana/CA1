const express = require('express');
const router = express.Router();
const { isPetOwner } = require('../middleware/auth');
const veterinaryDirectoryController = require('../controllers/veterinaryDirectoryController');

router.get('/vets', isPetOwner, veterinaryDirectoryController.directory);

module.exports = router;
