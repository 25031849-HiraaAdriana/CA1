const express = require('express');
const router = express.Router();
const { isPetOwner } = require('../middleware/auth');
const { csrfToken, csrfProtection } = require('../middleware/csrf');
const refillCartController = require('../controllers/refillCartController');
const petShopController = require('../controllers/petShopController');

router.get('/shop', isPetOwner, csrfToken, petShopController.listCatalog);
router.get('/shop/brands/:brandCode', isPetOwner, csrfToken, petShopController.viewBrand);
router.get('/shop/collections/:categoryCode', isPetOwner, csrfToken, petShopController.viewCollection);
router.get('/shop/products/:id', isPetOwner, csrfToken, petShopController.viewProduct);
router.post('/shop/favourites/:id', isPetOwner, csrfProtection, petShopController.setFavourite);
router.get('/cart', isPetOwner, csrfToken, petShopController.viewCart);
router.get('/refill-cart', isPetOwner, csrfToken, refillCartController.viewCart);
router.post('/refill-cart/:requestId/fulfilment', isPetOwner, csrfProtection, refillCartController.setDelivery);
router.post('/cart/items/:id', isPetOwner, csrfProtection, petShopController.addToCart);
router.post('/cart/items/:itemId/quantity', isPetOwner, csrfProtection, petShopController.updateCartItem);
router.post('/cart/items/:itemId/remove', isPetOwner, csrfProtection, petShopController.removeCartItem);
router.post('/dashboard/recently-viewed/clear', isPetOwner, csrfProtection, petShopController.clearRecentlyViewed);

module.exports = router;
