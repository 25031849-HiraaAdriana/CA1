const connection = require('../config/db');
const db = connection.promise();

const fields = `a.id, a.pet_id, a.clinic_name, a.appointment_type,
  DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS appointment_date,
  TIME_FORMAT(a.appointment_time, '%H:%i') AS appointment_time,
  a.notes, a.status, a.created_by, a.updated_by,
  p.name AS pet_name, p.owner_id, p.status AS pet_status, owner.name AS owner_name,
  a.created_by_name AS creator_name, a.updated_by_name AS updater_name`;
const joins = `FROM appointments a
  INNER JOIN pets p ON p.id = a.pet_id
  INNER JOIN users owner ON owner.id = p.owner_id`;

async function getPets(ownerId) {
  const [rows] = await db.query(
    `SELECT p.id, p.name, p.avs_licence_number, p.microchip_id
     FROM pets p WHERE p.owner_id = ? AND p.status = 'active' ORDER BY p.name, p.id`,
    [ownerId]
  );
  return rows;
}

async function searchOwners(search) {
  const [rows] = await db.query(
    `SELECT u.id, u.name FROM users u WHERE LOCATE(?, u.name) > 0
     AND EXISTS (SELECT 1 FROM pets p WHERE p.owner_id = u.id AND p.status = 'active')
     ORDER BY u.name, u.id LIMIT 20`,
    [search]
  );
  return rows;
}

async function getOwner(ownerId) {
  const [rows] = await db.query('SELECT id, name FROM users WHERE id = ?', [ownerId]);
  return rows[0] || null;
}

async function listAdmin({ search, filter, page, now }) {
  const upcoming = `(a.appointment_date > ? OR (a.appointment_date = ? AND a.appointment_time >= ?))`;
  const period = {
    all: '1 = 1',
    upcoming: `a.status = 'scheduled' AND ${upcoming}`,
    past: `a.status = 'scheduled' AND NOT ${upcoming}`,
    cancelled: "a.status = 'cancelled'"
  };
  const params = [search, search, search];
  if (filter === 'upcoming' || filter === 'past') params.push(now.date, now.date, now.time);
  params.push(11, (page - 1) * 10);
  const [rows] = await db.query(
    `SELECT * FROM (
       SELECT ${fields}, a.appointment_date AS sort_date, a.appointment_time AS sort_time,
         CASE WHEN a.status = 'cancelled' THEN 'Cancelled'
           WHEN ${upcoming} THEN 'Upcoming' ELSE 'Past' END AS display_status
       ${joins}
       WHERE (LOCATE(?, owner.name) > 0 OR LOCATE(?, p.name) > 0 OR LOCATE(?, a.clinic_name) > 0)
         AND ${period[filter]}
     ) results
     ORDER BY CASE display_status WHEN 'Upcoming' THEN 0 WHEN 'Past' THEN 1 ELSE 2 END,
       CASE WHEN display_status = 'Upcoming' THEN sort_date END ASC,
       CASE WHEN display_status = 'Upcoming' THEN sort_time END ASC,
       sort_date DESC, sort_time DESC, id DESC
     LIMIT ? OFFSET ?`,
    [now.date, now.date, now.time, ...params]
  );
  return { appointments: rows.slice(0, 10), hasNext: rows.length > 10 };
}

async function find(id, ownerId) {
  const [rows] = await db.query(
    `SELECT ${fields} ${joins} WHERE a.id = ? ${ownerId === null ? '' : "AND p.owner_id = ? AND p.status = 'active'"} LIMIT 1`,
    ownerId === null ? [id] : [id, ownerId]
  );
  return rows[0] || null;
}

async function nextForOwner(ownerId, now) {
  const [rows] = await db.query(
    `SELECT ${fields} ${joins}
     WHERE p.owner_id = ? AND p.status = 'active' AND a.status = 'scheduled'
       AND (a.appointment_date > ? OR (a.appointment_date = ? AND a.appointment_time >= ?))
     ORDER BY a.appointment_date, a.appointment_time, a.id LIMIT 1`,
    [ownerId, now.date, now.date, now.time]
  );
  return rows[0] || null;
}

async function create(data, actor) {
  const [result] = await db.query(
    `INSERT INTO appointments
     (pet_id, clinic_name, appointment_type, appointment_date, appointment_time, notes,
      created_by, updated_by, created_by_name, updated_by_name)
     SELECT p.id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM pets p
     WHERE p.id = ? AND p.owner_id = ? AND p.status = 'active'`,
    [data.clinicName, data.type, data.date, data.time, data.notes, actor.id, actor.id, actor.name, actor.name, data.petId,
      data.ownerId]
  );
  return result.affectedRows === 1;
}

async function update(id, data, actor) {
  const [result] = await db.query(
    `UPDATE appointments a
     INNER JOIN pets current_pet ON current_pet.id = a.pet_id
     INNER JOIN pets selected_pet ON selected_pet.id = ?
     SET a.pet_id = selected_pet.id, a.clinic_name = ?, a.appointment_type = ?,
         a.appointment_date = ?, a.appointment_time = ?, a.notes = ?, a.updated_by = ?, a.updated_by_name = ?
     WHERE a.id = ? AND a.status = 'scheduled' AND selected_pet.owner_id = ?
       AND selected_pet.status = 'active' AND current_pet.status = 'active'`,
    [data.petId, data.clinicName, data.type, data.date, data.time, data.notes, actor.id, actor.name, id,
      data.ownerId]
  );
  return result.affectedRows === 1;
}

async function reschedule(id, data, actor, ownerId) {
  const [result] = await db.query(
    `UPDATE appointments a INNER JOIN pets p ON p.id = a.pet_id
     SET a.appointment_date = ?, a.appointment_time = ?, a.updated_by = ?, a.updated_by_name = ?
     WHERE a.id = ? AND a.status = 'scheduled' AND p.owner_id = ? AND p.status = 'active'`,
    [data.date, data.time, actor.id, actor.name, id, ownerId]
  );
  return result.affectedRows === 1;
}

async function cancel(id, actor, ownerId) {
  const [result] = await db.query(
    `UPDATE appointments a INNER JOIN pets p ON p.id = a.pet_id
     SET a.status = 'cancelled', a.updated_by = ?, a.updated_by_name = ?
     WHERE a.id = ? AND a.status = 'scheduled' ${ownerId === null ? '' : "AND p.owner_id = ? AND p.status = 'active'"}`,
    ownerId === null ? [actor.id, actor.name, id] : [actor.id, actor.name, id, ownerId]
  );
  return result.affectedRows === 1;
}

module.exports = { getPets, searchOwners, getOwner, listAdmin, find, nextForOwner, create, update, reschedule, cancel };
