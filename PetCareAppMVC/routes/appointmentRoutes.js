const express = require('express');
const { isAdmin, isPetOwner } = require('../middleware/auth');
const { csrfToken, csrfProtection } = require('../middleware/csrf');
const controller = require('../controllers/appointmentController');

function routes(admin) {
  const router = express.Router();
  router.use(admin ? isAdmin : isPetOwner);
  router.use((req, res, next) => { req.appointmentAdmin = admin; next(); });
  if (admin) {
    router.get('/', csrfToken, controller.list);
    router.get('/new', csrfToken, controller.showForm);
    router.post('/', csrfProtection, controller.save);
  } else {
    router.get('/', (req, res) => res.redirect('/dashboard'));
    router.get('/new', (req, res) => res.status(403).send('Only admins can add appointments.'));
    router.post('/', (req, res) => res.status(403).send('Only admins can add appointments.'));
  }
  router.get('/:id/edit', csrfToken, controller.showForm);
  router.post('/:id', csrfProtection, controller.save);
  router.post('/:id/cancel', csrfProtection, controller.cancel);
  return router;
}

const router = express.Router();
router.use('/appointments', routes(false));
router.use('/admin/appointments', routes(true));
module.exports = router;
