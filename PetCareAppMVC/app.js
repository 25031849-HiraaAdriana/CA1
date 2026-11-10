// Pomi application
const { loadEnvironment, requireSessionSecret } = require('./config/environment');
loadEnvironment();
const { displayPetShopBrandName } = require('./helpers/petShopBrandName');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const app = express();
const PORT = 3000;
const sessionSecret = requireSessionSecret();

// View Engine and Middleware
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
  name: 'pomi.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(require('./middleware/sessionErrors'));

app.use(require('./middleware/csrf').csrfToken);
app.use(flash());
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.displayPetShopBrandName = displayPetShopBrandName;
  next();
});
app.use(require('./middleware/cartCount'));

// Routes
app.use(require('./routes/indexRoutes'));
app.use(require('./routes/veterinaryRoutes'));
app.use(require('./routes/authRoutes'));
app.use(require('./routes/adminRoutes'));
app.use(require('./routes/appointmentRoutes'));
app.use(require('./routes/petShopRoutes'));
app.use(require('./routes/petRoutes'));
app.use(require('./routes/paymentRoutes'));

// =========================
// Start Server
// =========================
app.listen(PORT, () => console.log(`App running on http://localhost:${PORT}`));

require('./config/db').query('SELECT 1', error => {
  if (error) {
    console.error(`MySQL connection check failed (${error.code || 'UNKNOWN'}). Start the MySQL95 Windows service and verify DB_HOST, DB_PORT, DB_USER and DB_PASSWORD in .env; login will fail until it succeeds.`);
  }
});
