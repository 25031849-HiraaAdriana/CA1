const petShopModel = require('../models/petShopModel');

async function cartCount(req, res, next) {
  if (req.method !== 'GET' || !req.session.user || req.session.user.role !== 'user') {
    return next();
  }

  try {
    if (await petShopModel.isFeatureReady()) {
      res.locals.cartCount = await petShopModel.getCartCount(req.session.user.id);
    } else {
      res.locals.cartCountUnavailable = true;
    }
  } catch (error) {
    console.error('Shopping cart count could not be loaded:', error.code || 'UNKNOWN');
    res.locals.cartCountUnavailable = true;
  }
  return next();
}

module.exports = cartCount;
