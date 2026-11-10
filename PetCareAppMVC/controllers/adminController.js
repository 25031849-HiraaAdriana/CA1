const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const userModel = require('../models/userModel');
const petModel = require('../models/petModel');
const avsLicenceDocument = require('../helpers/avsLicenceDocument');
const { identifyPetPhoto } = require('../helpers/petPhoto');

const speciesNames = {
  dog: 'Dog',
  cat: 'Cat',
  rabbit: 'Rabbit',
  hamster: 'Hamster',
  'guinea pig': 'Guinea Pig'
};

const imageDirectory = path.resolve(__dirname, '..', 'public', 'images');

function dashboard(req, res) {
  res.render('adminDashboard', { session: req.session });
}

function parseId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) &&
    Number(value) <= 4294967295 ? value : null;
}

function petImageUrl(image) {
  if (typeof image !== 'string' || !image || path.basename(image) !== image) return null;
  const imagePath = path.resolve(imageDirectory, image);
  return fs.existsSync(imagePath) ? `/images/${encodeURIComponent(image)}` : null;
}

async function listUsers(req, res) {
  try {
    const users = await new Promise((resolve, reject) => {
      userModel.getAllUsers((error, rows) => error ? reject(error) : resolve(rows));
    });
    return res.render('adminUsers', {
      users,
      session: req.session,
      csrfToken: req.session.csrfToken,
      successMessage: req.flash('success')[0] || null,
      errorMessage: req.flash('error')[0] || null
    });
  } catch (error) {
    console.error('Admin user list query failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load users right now.');
  }
}

async function viewUserDetails(req, res) {
  const userId = parseId(req.params.id);
  if (!userId) return res.status(404).send('User not found.');
  try {
    const user = await userModel.findUser(userId);
    if (!user) return res.status(404).send('User not found.');
    const pets = await new Promise((resolve, reject) => {
      petModel.getAllPetsByOwner(userId, (error, rows) => error ? reject(error) : resolve(rows));
    });
    return res.render('adminUserDetails', {
      user,
      pets: pets.map(pet => ({ ...pet, imageUrl: petImageUrl(pet.image) })),
      session: req.session,
      csrfToken: req.session.csrfToken,
      successMessage: req.flash('success')[0] || null,
      errorMessage: req.flash('error')[0] || null
    });
  } catch (error) {
    console.error('Admin user details query failed:', error.code || 'UNKNOWN');
    return res.status(error.code === 'ER_BAD_FIELD_ERROR' ? 503 : 500).send(
      error.code === 'ER_BAD_FIELD_ERROR'
        ? 'Pet status is unavailable until the reviewed pet-status migration is applied.'
        : 'Unable to retrieve user and pet information right now.'
    );
  }
}

async function editUserForm(req, res) {
  const userId = parseId(req.params.id);
  if (!userId) return res.status(404).send('User not found.');
  try {
    const user = await userModel.findUser(userId);
    if (!user) return res.status(404).send('User not found.');
    return res.render('adminUserEdit', {
      session: req.session,
      csrfToken: req.session.csrfToken,
      user,
      values: { name: user.name, username: user.username },
      errorMessage: null
    });
  } catch (error) {
    console.error('Admin user edit lookup failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load this user account right now.');
  }
}

async function updateUser(req, res) {
  const userId = parseId(req.params.id);
  if (!userId) return res.status(404).send('User not found.');
  const values = {
    name: typeof req.body.name === 'string' ? req.body.name.trim() : '',
    username: typeof req.body.username === 'string' ? req.body.username.trim() : ''
  };
  if (!values.name || values.name.length > 100 ||
      !values.username || values.username.length > 50 ||
      /[\u0000-\u001f\u007f]/.test(values.name + values.username)) {
    const user = await userModel.findUser(userId);
    if (!user) return res.status(404).send('User not found.');
    return res.status(400).render('adminUserEdit', {
      session: req.session, csrfToken: req.session.csrfToken, user, values,
      errorMessage: 'Enter a name (up to 100 characters) and username (up to 50 characters).'
    });
  }
  try {
    const user = await userModel.findUser(userId);
    if (!user) return res.status(404).send('User not found.');
    if (!(await userModel.updateUserProfile(userId, values))) {
      return res.status(404).send('User not found.');
    }
    if (String(req.session.user.id) === userId) {
      req.session.user.name = values.name;
      req.session.user.username = values.username;
    }
    req.flash('success', 'User details updated.');
    return res.redirect(`/admin/users/${userId}`);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      const user = await userModel.findUser(userId);
      if (!user) return res.status(404).send('User not found.');
      return res.status(409).render('adminUserEdit', {
        session: req.session, csrfToken: req.session.csrfToken, user, values,
        errorMessage: 'That username is already in use.'
      });
    }
    console.error('Admin user update failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to update user details right now.');
  }
}

async function confirmDeleteUser(req, res) {
  const userId = parseId(req.params.id);
  if (!userId) return res.status(404).send('User not found.');
  try {
    const user = await userModel.getUserDeletionTarget(userId);
    if (!user) return res.status(404).send('User not found.');
    const canDelete = user.role === 'user' &&
      String(user.id) !== String(req.session.user.id) &&
      Number(user.has_pets) === 0;
    return res.render('adminUserDeleteConfirm', {
      session: req.session,
      csrfToken: req.session.csrfToken,
      user,
      canDelete,
      errorMessage: null
    });
  } catch (error) {
    console.error('Admin user deletion preflight failed:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to verify whether this account can be deleted.');
  }
}

async function deleteUser(req, res) {
  const userId = parseId(req.params.id);
  if (!userId) return res.status(404).send('User not found.');
  try {
    const user = await userModel.getUserDeletionTarget(userId);
    if (!user) return res.status(404).send('User not found.');
    const canDelete = user.role === 'user' &&
      String(user.id) !== String(req.session.user.id) &&
      Number(user.has_pets) === 0;
    const confirmedUsername = typeof req.body.confirm_username === 'string'
      ? req.body.confirm_username.trim()
      : '';
    if (!canDelete || confirmedUsername !== user.username) {
      return res.status(409).render('adminUserDeleteConfirm', {
        session: req.session, csrfToken: req.session.csrfToken, user, canDelete,
        errorMessage: canDelete
          ? 'Type the account username exactly to confirm deletion.'
          : 'This account cannot be deleted because it is an Admin, your own account, or has registered pets.'
      });
    }
    if (!(await userModel.deleteUserIfNoPets(userId, user.username))) {
      return res.status(409).send('The account changed or gained pet records. No deletion was performed.');
    }
    req.flash('success', 'User account deleted.');
    return res.redirect('/admin/users');
  } catch (error) {
    console.error('Admin user deletion failed:', error.code || 'UNKNOWN');
    return res.status(409).send(
      'The account could not be deleted because protected records still reference it. No related pet or medical history was removed.'
    );
  }
}

function renderPetForm(req, res, pet, values, options = {}) {
  return res.status(options.statusCode || 200).render('adminPetEdit', {
    session: req.session,
    csrfToken: req.session.csrfToken,
    pet: { ...pet, imageUrl: petImageUrl(pet.image) },
    values,
    errorMessage: options.errorMessage || null
  });
}

function petFormValues(body, pet) {
  return {
    pet_name: typeof body.pet_name === 'string' ? body.pet_name.trim() : pet.name,
    species: typeof body.species === 'string' ? body.species.trim() : pet.species,
    breed: typeof body.breed === 'string' ? body.breed.trim() : pet.breed,
    age: typeof body.age === 'string' ? body.age.trim() : String(pet.age),
    avs_licence_number: typeof body.avs_licence_number === 'string'
      ? body.avs_licence_number.trim() : (pet.avs_licence_number || ''),
    microchip_id: typeof body.microchip_id === 'string'
      ? body.microchip_id.trim() : (pet.microchip_id || ''),
    correction_reason: typeof body.correction_reason === 'string'
      ? body.correction_reason.trim() : ''
  };
}

function validateIdentifier(value, maxLength) {
  return value.length <= maxLength &&
    (!value || (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && /\d/.test(value)));
}

async function editPetForm(req, res) {
  const petId = parseId(req.params.id);
  if (!petId) return res.status(404).send('Pet not found.');
  try {
    const pet = await petModel.getPetById(petId);
    if (!pet) return res.status(404).send('Pet not found.');
    return renderPetForm(req, res, pet, petFormValues({}, pet));
  } catch (error) {
    console.error('Admin pet edit lookup failed:', error.code || 'UNKNOWN');
    return res.status(error.code === 'ER_BAD_FIELD_ERROR' ? 503 : 500).send(
      error.code === 'ER_BAD_FIELD_ERROR'
        ? 'Pet status is unavailable until the reviewed pet-status migration is applied.'
        : 'Unable to load this pet right now.'
    );
  }
}

async function updatePet(req, res) {
  const petId = parseId(req.params.id);
  if (!petId) return res.status(404).send('Pet not found.');
  let pet;
  try {
    pet = await petModel.getPetById(petId);
  } catch (error) {
    console.error('Admin pet edit lookup failed:', error.code || 'UNKNOWN');
    return res.status(error.code === 'ER_BAD_FIELD_ERROR' ? 503 : 500).send(
      error.code === 'ER_BAD_FIELD_ERROR'
        ? 'Pet status is unavailable until the reviewed pet-status migration is applied.'
        : 'Unable to load this pet right now.'
    );
  }
  if (!pet) return res.status(404).send('Pet not found.');

  const values = petFormValues(req.body || {}, pet);
  const speciesKey = values.species.toLowerCase();
  const species = Object.hasOwn(speciesNames, speciesKey) ? speciesNames[speciesKey] : null;
  const age = values.age === '' ? NaN : Number(values.age);
  const currentIsRegulated = ['dog', 'cat'].includes(String(pet.species).toLowerCase());
  const requiresIdentifiers = speciesKey === 'dog' || speciesKey === 'cat';
  const avsLicenceNumber = values.avs_licence_number || null;
  const microchipId = values.microchip_id || null;
  const identifiersChanged =
    (pet.avs_licence_number || null) !== avsLicenceNumber ||
    (pet.microchip_id || null) !== microchipId;
  const imageFile = req.files && req.files.pet_image ? req.files.pet_image[0] : null;
  const documentFile = req.files && req.files.avs_licence_document
    ? req.files.avs_licence_document[0]
    : null;
  const maxFileSize = 5 * 1024 * 1024;
  if ((imageFile && imageFile.buffer.length > maxFileSize) ||
      (documentFile && documentFile.buffer.length > maxFileSize)) {
    if (imageFile) imageFile.buffer = undefined;
    if (documentFile) documentFile.buffer = undefined;
    return renderPetForm(req, res, pet, values, {
      statusCode: 413,
      errorMessage: 'Each pet photo or AVS licence PDF must be no larger than 5 MB.'
    });
  }

  const invalidProfile = !values.pet_name || values.pet_name.length > 80 ||
    !species || !values.breed || values.breed.length > 80 ||
    !Number.isInteger(age) || age < 0 || age > 255;
  const invalidIdentifiers = values.avs_licence_number.length > 50 ||
    !validateIdentifier(values.avs_licence_number, 50) ||
    values.microchip_id.length > 30 || !validateIdentifier(values.microchip_id, 30) ||
    (requiresIdentifiers && (!avsLicenceNumber || !microchipId)) ||
    (!requiresIdentifiers && Boolean(avsLicenceNumber));

  if (invalidProfile || invalidIdentifiers) {
    return renderPetForm(req, res, pet, values, {
      statusCode: 400,
      errorMessage: invalidProfile
        ? 'Enter a pet name, supported species, breed and an age from 0 to 255.'
        : requiresIdentifiers
          ? 'Dogs and cats require valid AVS licence and Microchip IDs.'
          : 'AVS licence numbers are not used for this species. Enter a valid optional Microchip ID or leave it blank.'
    });
  }
  if (currentIsRegulated && !requiresIdentifiers) {
    return renderPetForm(req, res, pet, values, {
      statusCode: 400,
      errorMessage: 'Changing a dog or cat to another species would require clearing its mandatory identity numbers. Use the separate identity-correction process.'
    });
  }
  if (identifiersChanged &&
      (!values.correction_reason || values.correction_reason.length > 500)) {
    return renderPetForm(req, res, pet, values, {
      statusCode: 400,
      errorMessage: 'Provide a correction reason (up to 500 characters) when changing AVS or Microchip identifiers.'
    });
  }

  let documentMatchedLocally = false;
  if (requiresIdentifiers && identifiersChanged) {
    if (!documentFile) {
      return renderPetForm(req, res, pet, values, {
        statusCode: 400,
        errorMessage: 'Upload the AVS licence PDF to locally match both identifiers before saving this correction.'
      });
    }
    try {
      const extracted = await avsLicenceDocument.extractIdentifiers(documentFile.buffer);
      if (extracted.avsLicenceNumber !== avsLicenceNumber ||
          extracted.microchipId !== microchipId) {
        return renderPetForm(req, res, pet, values, {
          statusCode: 400,
          errorMessage: 'The uploaded AVS licence document does not locally match both entered identifiers.'
        });
      }
      documentMatchedLocally = true;
    } catch (error) {
      return renderPetForm(req, res, pet, values, {
        statusCode: 400,
        errorMessage: 'The AVS licence PDF could not be read and locally matched. No changes were saved.'
      });
    } finally {
      documentFile.buffer = undefined;
    }
  } else if (documentFile && !requiresIdentifiers) {
    documentFile.buffer = undefined;
    return renderPetForm(req, res, pet, values, {
      statusCode: 400,
      errorMessage: 'An AVS licence PDF is not used for this species.'
    });
  }
  if (documentFile && !documentMatchedLocally) documentFile.buffer = undefined;

  let imageName = null;
  let newImagePath = null;
  if (imageFile) {
    const imageType = identifyPetPhoto(imageFile.mimetype, imageFile.buffer);
    if (!imageType) {
      imageFile.buffer = undefined;
      return renderPetForm(req, res, pet, values, {
        statusCode: 400,
        errorMessage: 'The uploaded pet photo content does not match an allowed JPEG, PNG or WebP image.'
      });
    }
    imageName = `${randomUUID()}${imageType.extension}`;
    newImagePath = path.join(imageDirectory, imageName);
    try {
      await fs.promises.writeFile(newImagePath, imageFile.buffer, { flag: 'wx' });
    } catch (error) {
      console.error('Admin pet photo storage failed:', error.code || 'UNKNOWN');
      return renderPetForm(req, res, pet, values, {
        statusCode: 500,
        errorMessage: 'Unable to store this pet photo right now. No pet details were changed.'
      });
    } finally {
      imageFile.buffer = undefined;
    }
  }

  const changedFields = [];
  if (values.pet_name !== pet.name) changedFields.push('name');
  if (species !== pet.species) changedFields.push('species');
  if (values.breed !== pet.breed) changedFields.push('breed');
  if (age !== Number(pet.age)) changedFields.push('age');
  if (identifiersChanged) changedFields.push('identifiers');
  if (imageName) changedFields.push('image');
  try {
    const updatedPet = await petModel.updatePetAsAdmin(petId, {
      name: values.pet_name,
      species,
      breed: values.breed,
      age,
      avsLicenceNumber,
      microchipId,
      image: imageName,
      changedFields,
      correctionReason: values.correction_reason || null,
      documentMatchedLocally
    }, req.session.user);
    if (!updatedPet) {
      if (newImagePath) {
        try {
          await fs.promises.unlink(newImagePath);
        } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') {
            console.error('Admin pet photo cleanup failed:', cleanupError.code || 'UNKNOWN');
          }
        }
      }
      return res.status(404).send('Pet not found. No changes were saved.');
    }
    req.flash('success', 'Pet details updated.');
    return res.redirect(`/admin/pets/${petId}`);
  } catch (error) {
    if (newImagePath && !error.commitOutcomeUnknown) {
      try {
        await fs.promises.unlink(newImagePath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          console.error('Admin pet photo cleanup failed:', cleanupError.code || 'UNKNOWN');
        }
      }
    }
    if (error.code === 'PET_IDENTIFIER_DUPLICATE' || error.code === 'ER_DUP_ENTRY') {
      return renderPetForm(req, res, pet, values, {
        statusCode: 409,
        errorMessage: 'That AVS licence number or Microchip ID is already registered to another pet.'
      });
    }
    console.error('Admin pet update failed:', error.code || 'UNKNOWN');
    const statusCode = error.code === 'ER_BAD_FIELD_ERROR' || error.code === 'ER_NO_SUCH_TABLE'
      ? 503 : 500;
    return res.status(statusCode).send(statusCode === 503
      ? 'Pet status and protected Admin audit tables are required. Review and apply the proposed migration before editing pets.'
      : 'Unable to save pet details and their audit entry. No partial change was committed.');
  }
}

async function viewPet(req, res) {
  const petId = parseId(req.params.id);
  if (!petId) return res.status(404).send('Pet not found.');
  try {
    const pet = await petModel.getPetById(petId);
    if (!pet) return res.status(404).send('Pet not found.');
    return res.render('adminPetDetails', {
      session: req.session,
      pet: { ...pet, imageUrl: petImageUrl(pet.image) }
    });
  } catch (error) {
    console.error('Admin pet detail query failed:', error.code || 'UNKNOWN');
    return res.status(error.code === 'ER_BAD_FIELD_ERROR' ? 503 : 500).send(
      error.code === 'ER_BAD_FIELD_ERROR'
        ? 'Pet status is unavailable until the reviewed pet-status migration is applied.'
        : 'Unable to load pet details right now.'
    );
  }
}

async function deceasedConfirmation(req, res) {
  const petId = parseId(req.params.id);
  if (!petId) return res.status(404).send('Pet not found.');
  try {
    const pet = await petModel.getPetById(petId);
    if (!pet) return res.status(404).send('Pet not found.');
    return res.render('adminPetDeceasedConfirm', {
      session: req.session, csrfToken: req.session.csrfToken, pet, errorMessage: null
    });
  } catch (error) {
    console.error('Pet archival confirmation lookup failed:', error.code || 'UNKNOWN');
    return res.status(error.code === 'ER_BAD_FIELD_ERROR' ? 503 : 500).send(
      error.code === 'ER_BAD_FIELD_ERROR'
        ? 'Pet status is unavailable until the reviewed pet-status migration is applied.'
        : 'Unable to load pet details right now.'
    );
  }
}

async function markPetDeceased(req, res) {
  const petId = parseId(req.params.id);
  if (!petId) return res.status(404).send('Pet not found.');
  const confirmation = typeof req.body.confirm_pet_name === 'string'
    ? req.body.confirm_pet_name.trim()
    : '';
  try {
    const pet = await petModel.getPetById(petId);
    if (!pet) return res.status(404).send('Pet not found.');
    if (pet.status !== 'active') {
      return res.status(409).send('This pet is already inactive. No changes were made.');
    }
    if (confirmation !== pet.name || req.body.confirm_deceased !== 'yes') {
      return res.status(400).render('adminPetDeceasedConfirm', {
        session: req.session, csrfToken: req.session.csrfToken, pet,
        errorMessage: 'Enter the pet name exactly and confirm the internal Pomi archival action.'
      });
    }
    const result = await petModel.markPetDeceased(petId, req.session.user);
    if (!result) return res.status(409).send('Pet status changed before confirmation. No changes were made.');
    req.flash('success', `${pet.name} was marked deceased in Pomi. No official AVS/PALS record was changed.`);
    return res.redirect(`/admin/users/${pet.owner_id}`);
  } catch (error) {
    console.error('Admin pet archival failed:', error.code || 'UNKNOWN');
    const statusCode = error.code === 'ER_BAD_FIELD_ERROR' || error.code === 'ER_NO_SUCH_TABLE'
      ? 503 : 500;
    return res.status(statusCode).send(statusCode === 503
      ? 'Pet status and protected Admin audit tables are required. Review and apply the proposed migration before archiving pets.'
      : 'Unable to archive this pet and record its audit entry. No partial change was committed.');
  }
}

function handlePetUploadError(req, res, error) {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).send('Each pet photo or AVS PDF must be no larger than 5 MB.');
  }
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).send('Upload at most one pet photo and one AVS licence PDF.');
  }
  if (error.code === 'INVALID_PET_IMAGE_TYPE' || error.code === 'INVALID_AVS_DOCUMENT_TYPE') {
    return res.status(400).send(error.message);
  }
  console.error('Admin pet upload failed:', error.code || 'UNKNOWN');
  return res.status(400).send('Unable to accept the uploaded pet files.');
}

module.exports = {
  dashboard,
  listUsers,
  viewUserDetails,
  editUserForm,
  updateUser,
  confirmDeleteUser,
  deleteUser,
  editPetForm,
  updatePet,
  viewPet,
  deceasedConfirmation,
  markPetDeceased,
  handlePetUploadError
};
