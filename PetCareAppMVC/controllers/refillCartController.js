const medicationRefillModel = require('../models/medicationRefillModel');
const { formatDemoCents } = require('../helpers/demoMoney');

async function viewCart(req, res) {
  try {
    const ready = await medicationRefillModel.isFeatureReady();
    const requests = ready ? await medicationRefillModel.getOwnerAcceptedDemoRefills(req.session.user.id) : [];
    const choices = req.session.refillDeliveryChoices || {};
    return res.render('refillDemoCart', {
      session: req.session,
      csrfToken: req.session.csrfToken,
      ready,
      requests: requests.map(request => {
        const quote = Number(request.demo_price_cents);
        if (!Number.isSafeInteger(quote) || quote <= 0) throw new Error('Invalid demo quotation.');
        const delivery = choices[String(request.id)] === 'delivery';
        return {
          ...request,
          delivery,
          quoteDisplay: formatDemoCents(quote),
          feeDisplay: formatDemoCents(delivery ? 1000 : 0),
          totalDisplay: formatDemoCents(quote + (delivery ? 1000 : 0))
        };
      })
    });
  } catch (error) {
    console.error('Refill demo cart lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load the refill demo cart right now.');
  }
}

async function setDelivery(req, res) {
  const id = req.params.requestId;
  const choice = req.body && req.body.fulfilment;
  if (!/^[1-9]\d{0,19}$/.test(id) || !['collection', 'delivery'].includes(choice)) {
    return res.status(400).send('Choose a valid demonstration delivery option.');
  }
  try {
    const requests = await medicationRefillModel.getOwnerAcceptedDemoRefills(req.session.user.id);
    if (!requests.some(request => String(request.id) === id)) return res.status(404).send('Refill request not found.');
    if (!req.session.refillDeliveryChoices) req.session.refillDeliveryChoices = {};
    req.session.refillDeliveryChoices[id] = choice;
    return res.redirect('/refill-cart');
  } catch (error) {
    console.error('Refill demo cart option failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to update the refill demo cart right now.');
  }
}

module.exports = { viewCart, setDelivery };
