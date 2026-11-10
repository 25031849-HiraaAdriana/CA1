const veterinaryDirectoryModel = require('../models/veterinaryDirectoryModel');

function directory(req, res) {
  return res.render('veterinaryDirectory', {
    session: req.session,
    clinics: veterinaryDirectoryModel.listClinics(),
    regions: veterinaryDirectoryModel.listRegions()
  });
}

module.exports = { directory };
