const { randomBytes } = require('crypto');
const userModel = require('../models/userModel');
const { sha256Hash } = require('../helpers/hash');
const { safeShopReturnTo } = require('../middleware/auth');

function signupForm(req, res) {
  res.render('signUp', {
    session: req.session,
    csrfToken: res.locals.csrfToken,
    messages: req.flash('success'),
    errors: req.flash('error')
  });
}

function signup(req, res) {
  const { username, password, name } = req.body;
  if (
    typeof username !== 'string' || !username.trim() || username.length > 50 ||
    typeof password !== 'string' || !password ||
    typeof name !== 'string' || !name.trim() || name.length > 100
  ) {
    req.flash('error', 'Enter a valid username, password, and name.');
    return res.redirect('/signup');
  }
  userModel.createUser(username, sha256Hash(password), name, 'user', err => {
    if (err) {
      console.error('Error creating user:', err.code || 'UNKNOWN');
      req.flash('error', err.code === 'ER_DUP_ENTRY'
        ? 'Username already exists.'
        : 'Sign up failed. Please try again.');
      return res.redirect('/signup');
    }
    req.flash('success', 'Account created successfully. Please log in to continue.');
    return res.redirect('/login');
  });
}

function loginForm(req, res) {
  res.render('login', {
    messages: req.flash('success'),
    errors: req.flash('error'),
    session: req.session,
    csrfToken: res.locals.csrfToken
  });
}

function login(req, res) {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string') {
    req.flash('error', 'Invalid username or password.');
    return res.redirect('/login');
  }
  userModel.findByCredentials(username, sha256Hash(password), (err, results) => {
    if (err) {
      console.error('Login query error:', err.code || 'UNKNOWN');
      req.flash('error', 'Unable to log in. Please try again.');
      return res.redirect('/login');
    }
    const account = results && results[0];
    if (!account || !['admin', 'user'].includes(account.role)) {
      req.flash('error', 'Invalid username or password.');
      return res.redirect('/login');
    }
    const returnTo = account.role === 'user' ? safeShopReturnTo(req.session.returnTo) : null;
    const finish = () => {
      req.session.csrfToken = randomBytes(32).toString('hex');
      req.session.user = {
        id: account.id, username: account.username, name: account.name, role: account.role
      };
      req.session.authenticatedAt = Date.now();
      if (account.role === 'user') req.session.loginSuccess = !returnTo;
      const redirect = () => res.redirect(returnTo || (account.role === 'admin' ? '/admin/dashboard' : '/dashboard'));
      if (typeof req.session.save !== 'function') return redirect();
      return req.session.save(error => {
        if (error) {
          console.error('Session save failed after authentication:', error.code || 'UNKNOWN');
          return res.status(500).send('Unable to complete sign in.');
        }
        return redirect();
      });
    };
    if (typeof req.session.regenerate !== 'function') return finish();
    return req.session.regenerate(error => {
      if (error) {
        console.error('Session regeneration failed after authentication:', error.code || 'UNKNOWN');
        return res.status(500).send('Unable to complete sign in.');
      }
      return finish();
    });
  });
}

function logout(req, res) {
  req.session.destroy(error => {
    if (error) {
      console.error('Logout session could not be destroyed:', error.code || 'UNKNOWN');
      return res.status(500).send('Unable to sign out right now.');
    }
    res.clearCookie('pomi.sid');
    return res.redirect('/login');
  });
}

module.exports = { signupForm, signup, loginForm, login, logout };
