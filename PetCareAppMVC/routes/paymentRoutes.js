const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

router.get('/payments/prepare/:serviceId', paymentController.preparePayment);

module.exports = router;
