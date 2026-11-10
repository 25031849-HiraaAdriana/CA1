// Auth Middleware
function safeShopReturnTo(value) {
  return typeof value === 'string' &&
    /^\/(?:shop(?:\/|[?#]|$)|cart(?:\/|[?#]|$))/.test(value) &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function isLoggedIn(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') return next();
  if (!req.session.user) return res.status(401).send('Authentication required.');
  return res.status(403).send('Access denied.');
}

function isPetOwner(req, res, next) {
  if (req.session.user && req.session.user.role === 'user') return next();
  if (req.session.user && req.session.user.role === 'admin') {
    return res.redirect('/admin/dashboard');
  }
  const returnTo = safeShopReturnTo(req.originalUrl);
  if (returnTo) req.session.returnTo = returnTo;
  return res.redirect('/login');
}

module.exports = { isLoggedIn, isAdmin, isPetOwner, safeShopReturnTo };
