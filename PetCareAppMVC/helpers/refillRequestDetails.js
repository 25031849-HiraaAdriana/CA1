const REASONS = ['Lost/Misplaced', 'Running Low', 'Insufficient Supply', 'Other'];
const DEMO_UNITS = ['tablets', 'capsules', 'mL', 'sachets', 'doses', 'units'];
const UINT_MAX = 4294967295;

function validateRefillDetails(reason, quantity, unit, documentedUnit) {
  if (typeof reason !== 'string' || !REASONS.includes(reason) ||
      typeof quantity !== 'string' || !/^[1-9]\d{0,9}$/.test(quantity) ||
      Number(quantity) > UINT_MAX || typeof unit !== 'string') return false;
  const expectedUnit = typeof documentedUnit === 'string' ? documentedUnit.trim() : '';
  return expectedUnit ? unit === expectedUnit : DEMO_UNITS.includes(unit);
}

module.exports = { REASONS, DEMO_UNITS, validateRefillDetails };
