const model = require('../models/appointmentModel');
const { singaporeNow, validDate } = require('../helpers/appointmentDates');

const TYPES = ['Checkup', 'Vaccination', 'Follow-up', 'Other'];
const MAX_ID = 18446744073709551615n;

function id(value, max = MAX_ID) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= max ? parsed.toString() : null;
}

function scope(req) {
  return req.appointmentAdmin ? null : req.session.user.id;
}

function base(req) {
  return req.appointmentAdmin ? '/admin/appointments' : '/appointments';
}

function returnTo(req) {
  return req.appointmentAdmin ? '/admin/appointments' : '/dashboard';
}

function actor(req) {
  const user = req.session.user;
  return { id: user.id, name: String(user.name || user.username || `User ${user.id}`).slice(0, 100) };
}

function parseForm(body) {
  if (!body || ['pet_id', 'clinic_name', 'appointment_type', 'appointment_date', 'appointment_time']
    .some(key => typeof body[key] !== 'string') ||
    (body.notes !== undefined && typeof body.notes !== 'string')) return null;
  const petId = id(body.pet_id, 4294967295n);
  const ownerId = id(body.owner_id, 4294967295n);
  const clinicName = body.clinic_name.trim();
  const notes = (body.notes || '').trim();
  if (!ownerId || !petId || !clinicName || clinicName.length > 150 || notes.length > 1000 ||
      !TYPES.includes(body.appointment_type) || !validDate(body.appointment_date) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.appointment_time)) return null;
  return { ownerId, petId, clinicName, type: body.appointment_type, date: body.appointment_date, time: body.appointment_time, notes: notes || null };
}

function parseReschedule(body) {
  if (!body || !validDate(body.appointment_date) || typeof body.appointment_time !== 'string' ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.appointment_time)) return null;
  return { date: body.appointment_date, time: body.appointment_time };
}

function handleError(res, error) {
  console.error('Appointment operation failed:', error.code || 'UNKNOWN');
  if (error.code === 'ER_NO_SUCH_TABLE') {
    return res.status(503).send('Appointments are unavailable until the appointment database migration is approved and applied.');
  }
  return res.status(500).send('Unable to process appointments right now.');
}

async function list(req, res) {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    const filter = ['all', 'upcoming', 'past', 'cancelled'].includes(req.query.filter) ? req.query.filter : 'all';
    const page = typeof req.query.page === 'string' && /^[1-9]\d{0,4}$/.test(req.query.page)
      ? Number(req.query.page) : 1;
    const { appointments, hasNext } = await model.listAdmin({ search, filter, page, now: singaporeNow() });
    return res.render('appointments', {
      session: req.session, base: base(req), isAdmin: req.appointmentAdmin,
      csrfToken: req.session.csrfToken,
      successMessage: req.flash('success')[0] || null,
      appointments, search, filter, page, hasNext
    });
  } catch (error) {
    return handleError(res, error);
  }
}

async function showForm(req, res, values = {}, errorMessage = null, status = 200) {
  const appointmentId = req.params.id ? id(req.params.id) : null;
  if (req.params.id && !appointmentId) return res.status(404).send('Appointment not found.');
  try {
    const appointment = appointmentId ? await model.find(appointmentId, scope(req)) : null;
    if (appointmentId && (!appointment || appointment.status !== 'scheduled' ||
        (req.appointmentAdmin && appointment.pet_status !== 'active'))) {
      return res.status(404).send('Appointment not found.');
    }
    const initial = appointment ? {
      owner_id: String(appointment.owner_id),
      pet_id: String(appointment.pet_id), clinic_name: appointment.clinic_name,
      appointment_type: appointment.appointment_type, appointment_date: appointment.appointment_date,
      appointment_time: appointment.appointment_time, notes: appointment.notes || ''
    } : { owner_id: '', pet_id: '', clinic_name: '', appointment_type: '', appointment_date: '', appointment_time: '', notes: '' };
    const formValues = errorMessage ? values : initial;
    const requestedOwnerId = id(typeof req.query.owner_id === 'string' ? req.query.owner_id : '', 4294967295n);
    if (req.appointmentAdmin && !errorMessage && requestedOwnerId) {
      formValues.owner_id = requestedOwnerId;
      if (!appointment || String(appointment.owner_id) !== requestedOwnerId) formValues.pet_id = '';
    }
    const ownerSearch = req.appointmentAdmin && typeof req.query.owner_search === 'string'
      ? req.query.owner_search.trim().slice(0, 100) : '';
    const owners = ownerSearch ? await model.searchOwners(ownerSearch) : [];
    const selectedOwnerId = req.appointmentAdmin ? id(formValues.owner_id, 4294967295n) : null;
    const selectedOwner = selectedOwnerId ? await model.getOwner(selectedOwnerId) : null;
    const pets = selectedOwner ? await model.getPets(selectedOwnerId) : [];
    return res.status(status).render('appointmentForm', {
      session: req.session, base: base(req), isAdmin: req.appointmentAdmin,
      csrfToken: req.session.csrfToken, appointmentId, pets, types: TYPES,
      values: formValues, errorMessage, appointment, ownerSearch, owners, selectedOwner
    });
  } catch (error) {
    return handleError(res, error);
  }
}

async function save(req, res) {
  const appointmentId = req.params.id ? id(req.params.id) : null;
  if (req.params.id && !appointmentId) return res.status(404).send('Appointment not found.');
  if (!appointmentId && !req.appointmentAdmin) return res.status(403).send('Only admins can add appointments.');
  const data = req.appointmentAdmin ? parseForm(req.body) : parseReschedule(req.body);
  if (!data) {
    const values = {};
    for (const key of ['owner_id', 'pet_id', 'clinic_name', 'appointment_type', 'appointment_date', 'appointment_time', 'notes']) {
      values[key] = req.body && typeof req.body[key] === 'string' ? req.body[key].slice(0, 1000) : '';
    }
    return showForm(req, res, values, req.appointmentAdmin
      ? 'Select an owner and pet, and enter a valid clinic, type, date and time. Notes are limited to 1,000 characters.'
      : 'Enter a valid date and time.', 400);
  }
  try {
    const saved = !req.appointmentAdmin
      ? await model.reschedule(appointmentId, data, actor(req), scope(req))
      : appointmentId
        ? await model.update(appointmentId, data, actor(req))
        : await model.create(data, actor(req));
    if (!saved) return res.status(404).send('Appointment or pet not found.');
    req.flash('success', appointmentId ? 'Appointment updated.' : 'Appointment added.');
    return res.redirect(returnTo(req));
  } catch (error) {
    return handleError(res, error);
  }
}

async function cancel(req, res) {
  const appointmentId = id(req.params.id);
  if (!appointmentId) return res.status(404).send('Appointment not found.');
  try {
    if (!(await model.cancel(appointmentId, actor(req), scope(req)))) {
      return res.status(404).send('Appointment not found.');
    }
    req.flash('success', 'Appointment cancelled.');
    return res.redirect(returnTo(req));
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = { list, showForm, save, cancel };
