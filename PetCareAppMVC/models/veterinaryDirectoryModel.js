const clinics = require('../data/veterinaryClinics');

const regions = ['North', 'North-East', 'East', 'West', 'South', 'Central'];

function listClinics() {
  return clinics.map(clinic => ({ ...clinic }));
}

function listRegions() {
  return [...regions];
}

module.exports = {
  listClinics,
  listRegions
};
