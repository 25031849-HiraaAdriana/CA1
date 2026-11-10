const medicationRefillModel = require('../models/medicationRefillModel');

const UINT_MAX = 4294967295;
const MAX_ID = 18446744073709551615n;
const ADMIN_STATUSES = new Set([
  'Rejected',
  'Ready for Test Payment'
]);

function parseId(value, maximum = MAX_ID) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(normalized)) return null;
  const id = BigInt(normalized);
  return id > 0n && id <= BigInt(maximum) ? id.toString() : null;
}

function parseDemoPriceCents(value) {
  if (typeof value !== 'string' || !/^\d{1,6}(?:\.\d{1,2})?$/.test(value.trim())) {
    return null;
  }
  const [whole, fraction = ''] = value.trim().split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 10000000
    ? cents
    : null;
}

function formatSgdCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const cents = BigInt(value);
  return `SGD ${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
}

async function listAdminRefillRequests(req, res) {
  try {
    const featureReady = await medicationRefillModel.isFeatureReady();
    const requests = featureReady
      ? await medicationRefillModel.getAdminRefillRequests()
      : [];
    return res.render('adminMedicationRefillRequests', {
      session: req.session,
      csrfToken: req.session.csrfToken,
      requests: requests.map(request => ({
        ...request,
        displayPrice: formatSgdCents(request.demo_price_cents)
      })),
      featureReady,
      errorMessage: req.flash('error')[0] || null,
      successMessage: req.flash('success')[0] || null
    });
  } catch (error) {
    console.error('Admin refill requests lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load refill requests right now.');
  }
}

async function reviewAdminRefillRequest(req, res) {
  const requestId = parseId(req.params.requestId);
  if (!requestId) return res.status(404).send('Refill request not found.');

  const body = req.body || {};
  if (typeof body.status !== 'string' ||
      (body.admin_review_note !== undefined && typeof body.admin_review_note !== 'string') ||
      (body.demo_price !== undefined && typeof body.demo_price !== 'string')) {
    req.flash('error', 'Submit a valid administrative review form.');
    return res.redirect('/admin/refill-requests');
  }
  const status = body.status;
  const note = (body.admin_review_note || '').trim();
  const priceValue = (body.demo_price || '').trim();
  const demoPriceCents = status === 'Ready for Test Payment'
    ? parseDemoPriceCents(priceValue)
    : null;

  if (!ADMIN_STATUSES.has(status) || note.length > 500 ||
      (status === 'Ready for Test Payment' && demoPriceCents === null)) {
    req.flash('error', 'Choose an allowed CA1 demo status, provide a valid positive SGD quotation if ready for test payment, and limit the review note to 500 characters.');
    return res.redirect('/admin/refill-requests');
  }

  try {
    const updated = await medicationRefillModel.updateAdminRefillRequest({
      requestId,
      status,
      demoPriceCents,
      reviewNote: note || null,
      adminId: req.session.user.id,
      adminUsername: req.session.user.username || null,
      adminName: req.session.user.name || req.session.user.username || null
    });
    if (!updated) {
      req.flash('error', 'Only Pending or More Information Required requests can receive an administrative demo review.');
      return res.redirect('/admin/refill-requests');
    }

    req.flash('success', 'Administrative demo review saved. This is not veterinary authorisation.');
    return res.redirect('/admin/refill-requests');
  } catch (error) {
    if (error.code === 'MEDICATION_REFILL_MIGRATION_REQUIRED') {
      return res.status(503).send('Medication refill requests are not available until the proposed database migration is approved and applied.');
    }
    console.error('Admin refill request review failed:', error.code || 'UNKNOWN');
    if (error.commitOutcomeUnknown) {
      return res.status(500).send('The review outcome is uncertain. Check the request and audit history before retrying.');
    }
    return res.status(500).send('Unable to save the administrative demo review right now.');
  }
}

module.exports = {
  listAdminRefillRequests,
  reviewAdminRefillRequest,
  parseDemoPriceCents,
  formatSgdCents
};
