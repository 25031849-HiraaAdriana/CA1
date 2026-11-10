const adminActivityModel = require('../models/adminActivityModel');

function parsePageNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function humanizeAction(actionType) {
  const normalized = String(actionType || '').replace(/_/g, ' ').toLowerCase();
  return normalized ? normalized.replace(/\b\w/g, char => char.toUpperCase()) : 'Activity';
}

function normalizeMetadata(metadata) {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata;
  }
  if (typeof metadata !== 'string' || !metadata.trim()) return null;

  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function listActivityHistory(req, res) {
  const page = parsePageNumber(req.query.page, 1);
  const limit = 20;
  const offset = (page - 1) * limit;
  const usernameQuery = req.query.admin_username || req.query.adminUsername || '';
  const adminUsername = typeof usernameQuery === 'string' ? usernameQuery.trim() : '';

  const featureReady = await adminActivityModel.isFeatureReady();
  const logsResult = featureReady
    ? await adminActivityModel.getAdminActivityLogs({ adminUsername }, { limit, offset })
    : { items: [], total: 0, migrationReady: false };

  const totalPages = Math.max(1, Math.ceil((logsResult.total || 0) / limit));
  const activities = (logsResult.items || []).map(activity => ({
    ...activity,
    metadata: normalizeMetadata(activity.metadata)
  }));

  return res.render('adminActivityHistory', {
    session: req.session,
    activities,
    adminUsername,
    page,
    totalPages,
    totalRecords: logsResult.total || 0,
    migrationReady: featureReady,
    humanizeAction,
    successMessage: req.flash('success')[0] || null,
    errorMessage: req.flash('error')[0] || null
  });
}

module.exports = { listActivityHistory, humanizeAction };
