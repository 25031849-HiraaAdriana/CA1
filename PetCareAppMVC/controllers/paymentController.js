const services = require('../data/mockServices');

function preparePayment(req, res) {
  const { serviceId } = req.params;

  if (!/^\d+$/.test(serviceId)) {
    return res.status(400).json({ error: 'Invalid serviceId' });
  }

  const parsedServiceId = Number(serviceId);
  if (!Number.isSafeInteger(parsedServiceId) || parsedServiceId <= 0) {
    return res.status(400).json({ error: 'Invalid serviceId' });
  }

  const service = services.find(item => item.id === parsedServiceId);
  if (!service) {
    return res.status(404).json({ error: 'Service not found' });
  }

  return res.status(200).json({
    serviceId: service.id,
    serviceName: service.name,
    amount: service.price,
    currency: 'sgd',
    status: 'READY_FOR_PAYMENT'
  });
}

module.exports = { preparePayment };
