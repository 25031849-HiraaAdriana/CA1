const petModel = require('../models/petModel');
const avsLicenceDocument = require('../helpers/avsLicenceDocument');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const speciesNames = {
  dog: 'Dog', cat: 'Cat', rabbit: 'Rabbit', hamster: 'Hamster', 'guinea pig': 'Guinea Pig'
};

const unreadableDocumentMessage = 'Registration Unsuccessful. Unable to verify both identifiers against the uploaded document.';
const mismatchedDocumentMessage = 'Registration Unsuccessful. The AVS licence number or Microchip ID does not match the uploaded document.';
const invalidDocumentMessage = 'Registration Unsuccessful. Please upload the AVS licence document as a PDF.';

function getRegistrationFormData(req) {
  const fields = ['pet_name', 'species', 'breed', 'age', 'avs_licence_number', 'microchip_id', 'has_microchip'];
  return fields.reduce((formData, field) => {
    formData[field] = typeof req.body[field] === 'string' ? req.body[field] : '';
    return formData;
  }, {});
}

function renderRegistrationForm(req, res, options = {}) {
  return res.status(options.statusCode || 200).render('newPet', {
    session: req.session,
    resultMessage: options.resultMessage || null,
    resultType: options.resultType || null,
    registrationComplete: false,
    formData: getRegistrationFormData(req),
    initialStep: options.initialStep || 4
  });
}

// Add Pet Form
function newPetForm(req, res) {
  res.render('newPet', {
    session: req.session,
    resultMessage: null,
    resultType: null,
    registrationComplete: false,
    formData: {},
    initialStep: 1
  });
}

// Handle Add Pet Submission
async function createPet(req, res) {
  const petName = typeof req.body.pet_name === 'string' ? req.body.pet_name.trim() : '';
  const speciesKey = typeof req.body.species === 'string' ? req.body.species.trim().toLowerCase() : '';
  const species = Object.hasOwn(speciesNames, speciesKey) ? speciesNames[speciesKey] : null;
  const requiresLicence = speciesKey === 'dog' || speciesKey === 'cat';
  const breed = typeof req.body.breed === 'string' ? req.body.breed.trim() : '';
  const avsLicenceNumber = typeof req.body.avs_licence_number === 'string'
    ? req.body.avs_licence_number.trim()
    : '';
  const microchipId = typeof req.body.microchip_id === 'string'
    ? req.body.microchip_id.trim()
    : '';
  const ageValue = typeof req.body.age === 'string' ? req.body.age.trim() : '';
  const age = ageValue === '' ? NaN : Number(ageValue);
  const petDetailsAreInvalid =
    !petName || petName.length > 80 ||
    !species ||
    !breed || breed.length > 80 ||
    !Number.isInteger(age) || age < 0 || age > 255;

  if (petDetailsAreInvalid) {
    return renderRegistrationForm(req, res, {
      statusCode: 400,
      resultMessage: 'Please provide a pet name, species, breed and valid age.',
      resultType: 'danger',
      initialStep: species ? 3 : 2
    });
  }

  const hasMicrochip = req.body.has_microchip;
  if (microchipId.length > 30 || avsLicenceNumber.length > 50 ||
      (!requiresLicence && microchipId &&
        (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(microchipId) || !/\d/.test(microchipId))) ||
      (requiresLicence && (!avsLicenceNumber || !microchipId)) ||
      (!requiresLicence && (
        !['yes', 'no'].includes(hasMicrochip) ||
        (hasMicrochip === 'yes' && !microchipId) ||
        (hasMicrochip === 'no' && microchipId) ||
        avsLicenceNumber
      ))) {
    return renderRegistrationForm(req, res, {
      statusCode: 400,
      resultMessage: requiresLicence
        ? 'Please provide a valid AVS licence number and Microchip ID.'
        : 'Please select whether your pet has a microchip and enter its real ID if applicable. AVS details are not needed for this species.',
      resultType: 'danger',
      initialStep: requiresLicence && microchipId ? 4 : 2
    });
  }

  const documentFile = req.files && req.files.avs_licence_document
    ? req.files.avs_licence_document[0]
    : null;
  if (!requiresLicence && documentFile) {
    return renderRegistrationForm(req, res, {
      statusCode: 400,
      resultMessage: 'An AVS licence document is not needed for this species. Please remove it and submit again.',
      resultType: 'danger'
    });
  }
  if (requiresLicence && !documentFile) {
    return renderRegistrationForm(req, res, {
      statusCode: 400,
      resultMessage: unreadableDocumentMessage,
      resultType: 'danger'
    });
  }

  if (requiresLicence) {
    let extractedIdentifiers;
    try {
      extractedIdentifiers = await avsLicenceDocument.extractIdentifiers(documentFile.buffer);
    } catch {
      documentFile.buffer = undefined;
      return renderRegistrationForm(req, res, {
        statusCode: 400, resultMessage: unreadableDocumentMessage, resultType: 'danger'
      });
    }
    documentFile.buffer = undefined;

    if (!extractedIdentifiers.avsLicenceNumber || !extractedIdentifiers.microchipId) {
      return renderRegistrationForm(req, res, {
        statusCode: 400, resultMessage: unreadableDocumentMessage, resultType: 'danger'
      });
    }
    if (extractedIdentifiers.avsLicenceNumber.trim() !== avsLicenceNumber ||
        extractedIdentifiers.microchipId.trim() !== microchipId) {
      return renderRegistrationForm(req, res, {
        statusCode: 400, resultMessage: mismatchedDocumentMessage, resultType: 'danger'
      });
    }
  }

  const imageFile = req.files && req.files.pet_image ? req.files.pet_image[0] : null;
  const extension = imageFile ? path.extname(imageFile.originalname).toLowerCase() : '';
  const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
  const petImage = imageFile ? `${randomUUID()}${safeExtension}` : null;
  const imagePath = petImage ? path.join(__dirname, '..', 'public', 'images', petImage) : null;
  if (imageFile) {
    try {
      await fs.writeFile(imagePath, imageFile.buffer, { flag: 'wx' });
    } catch (error) {
      console.error('Pet photo storage failed:', error.code || 'UNKNOWN');
      return renderRegistrationForm(req, res, {
        statusCode: 500, resultMessage: 'Unable to save the pet photo right now. Please try again.', resultType: 'danger'
      });
    }
  }
  const ownerId = req.session.user.id;

  petModel.createPet(
    ownerId,
    petName,
    species,
    breed,
    age,
    avsLicenceNumber || null,
    microchipId || null,
    petImage,
    async (err, result) => {
      if (err) {
        if (imagePath) {
          try {
            await fs.unlink(imagePath);
          } catch (cleanupError) {
            console.error('Pet photo cleanup failed:', cleanupError.code || 'UNKNOWN');
          }
        }
        if (err.code === 'PET_IDENTIFIER_DUPLICATE') {
          return renderRegistrationForm(req, res, {
            statusCode: 409,
            resultMessage: 'Registration Unsuccessful. This AVS licence number or Microchip ID is already registered in Pomi.',
            resultType: 'danger'
          });
        }

        console.error('Pet registration database operation failed:', err.code || 'UNKNOWN');
        return renderRegistrationForm(req, res, {
          statusCode: 500,
          resultMessage: 'Unable to register pet right now. Please try again.',
          resultType: 'danger'
        });
      }

      return res.render('newPet', {
        session: req.session,
        registrationComplete: true,
        registeredPet: {
          name: petName,
          profileUrl: result && result.insertId
            ? `/pets/${encodeURIComponent(result.insertId)}`
            : null
        }
      });
    }
  );
}

function handleUploadError(req, res, err) {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return renderRegistrationForm(req, res, {
      statusCode: 413,
      resultMessage: 'Registration Unsuccessful. Uploaded files must be no larger than 5 MB.',
      resultType: 'danger'
    });
  }

  if (err.code === 'INVALID_AVS_DOCUMENT_TYPE' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return renderRegistrationForm(req, res, {
      statusCode: 400,
      resultMessage: invalidDocumentMessage,
      resultType: 'danger'
    });
  }

  console.error('Pet document upload failed:', err.code || 'UNKNOWN');
  return renderRegistrationForm(req, res, {
    statusCode: 500,
    resultMessage: 'Unable to process the uploaded files right now. Please try again.',
    resultType: 'danger'
  });
}

function viewPet(req, res) {
  const ownerId = req.session.user.id;

  petModel.getPetsByOwner(ownerId, (err, pets) => {
    if (err) {
      console.error('Pet profile database operation failed:', err.code || 'UNKNOWN');
      return res.status(500).send('Unable to load this pet profile right now.');
    }

    const pet = pets.find(item => String(item.id) === req.params.id);
    if (!pet) return res.status(404).send('Pet profile not found.');

    return res.render('petProfile', {
      session: req.session,
      pet
    });
  });
}

module.exports = { newPetForm, createPet, handleUploadError, viewPet };
