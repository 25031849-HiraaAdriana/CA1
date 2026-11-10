const fs = require('fs');
const path = require('path');
const petModel = require('../models/petModel');
const petShopModel = require('../models/petShopModel');
const medicationRefillModel = require('../models/medicationRefillModel');
const appointmentModel = require('../models/appointmentModel');
const { singaporeNow } = require('../helpers/appointmentDates');
const { formatDemoCents } = require('../helpers/demoMoney');

function index(req, res) {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin/dashboard' : '/dashboard');
  }

  res.render('index', { session: req.session });
}

function dashboard(req, res) {
  const ownerId = req.session.user.id;

  petModel.getPetsByOwner(ownerId, (err, pets) => {
    if (err) {
      console.error('Owner dashboard pet query failed:', err.code || 'UNKNOWN');
      return res.status(500).send('Unable to load your dashboard right now.');
    }

    const imageDirectory = path.resolve(__dirname, '..', 'public', 'images');
    const dashboardPets = pets.map(pet => {
      const filename = typeof pet.image === 'string' ? pet.image : '';
      const imagePath = path.resolve(imageDirectory, filename);
      const hasImage = filename !== '' &&
        path.basename(filename) === filename &&
        fs.existsSync(imagePath);

      return {
        ...pet,
        imageUrl: hasImage ? `/images/${encodeURIComponent(filename)}` : null
      };
    });

    const loginSuccessMessage = req.session.loginSuccess ? 'Login successful!' : null;
    delete req.session.loginSuccess;
    (async () => {
      try {
        const historyReady = await petShopModel.isFeatureReady();
        const [favourites, recentlyViewed] = historyReady
          ? await Promise.all([
            petShopModel.getFavouriteProducts(ownerId),
            petShopModel.getRecentlyViewedProducts(ownerId)
          ])
          : [[], []];
        let refillReady = false;
        let refills = [];
        try {
          refillReady = await medicationRefillModel.isFeatureReady();
          if (refillReady) refills = await medicationRefillModel.getOwnerAcceptedDemoRefills(ownerId);
        } catch (error) {
          console.error('Owner refill reminders could not be loaded:', error.code || 'UNKNOWN');
          refillReady = false;
        }
        let nextAppointment = null;
        let appointmentsAvailable = true;
        try {
          nextAppointment = await appointmentModel.nextForOwner(ownerId, singaporeNow());
        } catch (error) {
          console.error('Owner appointments could not be loaded:', error.code || 'UNKNOWN');
          appointmentsAvailable = false;
        }
        return res.render('userDashboard', {
          session: req.session,
          pets: dashboardPets,
          loginSuccessMessage,
          favourites,
          recentlyViewed,
          refillReady,
          nextAppointment,
          appointmentsAvailable,
          refillReminders: refills.map(refill => ({
            ...refill,
            displayPrice: formatDemoCents(refill.demo_price_cents)
          })),
          shopHistoryReady: historyReady,
          csrfToken: req.session.csrfToken,
          successMessage: typeof req.flash === 'function' ? req.flash('success')[0] || null : null,
          errorMessage: typeof req.flash === 'function' ? req.flash('error')[0] || null : null
        });
      } catch (dashboardError) {
        console.error('Owner dashboard shop history query failed:', dashboardError.code || 'UNKNOWN');
        return res.status(500).send('Unable to load your dashboard right now.');
      }
    })();
  });
}

module.exports = { index, dashboard };
