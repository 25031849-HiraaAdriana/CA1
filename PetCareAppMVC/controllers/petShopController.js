const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const petShopModel = require('../models/petShopModel');
const { storedPetShopBrandName } = require('../helpers/petShopBrandName');
const adminActivityModel = require('../models/adminActivityModel');
const privatePetShopStorage = require('../helpers/privatePetShopStorage');

const publicProductDirectory = path.resolve(__dirname, '..', 'public', 'images', 'products');
const categoryPhotography = {
  'animal-medical-healthcare': 'https://images.unsplash.com/photo-1583337130417-3346a1be7dee?auto=format&fit=crop&w=900&q=82',
  'animal-food-beverages': 'https://images.unsplash.com/photo-1573865526739-10659fec78a5?auto=format&fit=crop&w=900&q=82',
  'animal-grooming-care': 'https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=900&q=82',
  'animal-accessories': 'https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=900&q=82'
};
const reviewStatuses = [
  'pending_review',
  'approved_for_internal_listing',
  'requires_additional_information',
  'rejected',
  'unavailable'
];
const safetyStatuses = ['pending', 'cleared', 'concern'];
const storefrontPlacements = [
  'pethub_products',
  'trusted_cats_dogs',
  'trusted_small_furries'
];
const priceRanges = [
  { value: '', label: 'Any Price' },
  { value: 'below-20', label: 'Below S$20' },
  { value: '20-50', label: 'S$20–S$50' },
  { value: '50-100', label: 'S$50–S$100' },
  { value: 'above-100', label: 'Above S$100' }
];

function parseId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function getText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function parseProductForm(body, isExisting = false) {
  const price = typeof body.price_sgd === 'string' ? body.price_sgd.trim() : '';
  const stock = typeof body.stock_quantity === 'string' ? body.stock_quantity.trim() : '';
  const categoryId = parseId(body.category_id);
  const speciesValues = Array.isArray(body.species_suitability)
    ? body.species_suitability
    : typeof body.species_suitability === 'string'
      ? body.species_suitability.split(',')
      : [];
  const speciesSuitability = [...new Set(speciesValues
    .filter(value => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean))];
  const ageSelection = body.age_suitability;
  const ageIsUnrestricted = ageSelection === 'none';
  const minimumAge = ageIsUnrestricted || body.minimum_age_months === undefined || body.minimum_age_months === ''
    ? null
    : Number(body.minimum_age_months);
  const maximumAge = ageIsUnrestricted || body.maximum_age_months === undefined || body.maximum_age_months === ''
    ? null
    : Number(body.maximum_age_months);
  const expiryDate = typeof body.expiry_date === 'string' ? body.expiry_date.trim() : '';

  const product = {
    categoryId,
    storefrontPlacement: storefrontPlacements.includes(body.storefront_placement)
      ? body.storefront_placement
      : null,
    trustedBrandId: null,
    productName: getText(body.product_name, 180),
    brand: storedPetShopBrandName(
      getText(body.trusted_brand_name, 120) || getText(body.brand, 120) || null
    ),
    description: getText(body.description, 10000),
    intendedPurpose: getText(body.intended_purpose, 500) || null,
    price,
    stockQuantity: Number(stock),
    isPrescriptionProduct: body.is_prescription_product === '1' ||
      (body.is_prescription_product === undefined && body.prescription_flag_fallback === '1'),
    isActive: body.is_active === '1',
    internalReviewStatus: body.internal_review_status,
    safetyReviewStatus: body.safety_review_status,
    ingredientsMaterials: getText(body.ingredients_materials, 10000) || null,
    speciesSuitability,
    minimumAgeMonths: minimumAge,
    maximumAgeMonths: maximumAge,
    usageInstructions: getText(body.usage_instructions, 5000) || null,
    safetyWarnings: getText(body.safety_warnings, 5000) || null,
    expiryDate: expiryDate || null,
    supplierName: getText(body.supplier_name, 180) || null,
    supplierReference: getText(body.supplier_reference, 500) || null,
    countryOfOrigin: getText(body.country_of_origin, 120) || null,
    supportingDocumentReference: getText(body.supporting_document_reference, 1000) || null,
    regulatoryAuthorityReference: getText(body.regulatory_authority_reference, 500) || null,
    submittedLicenceNumber: getText(body.submitted_licence_number, 180) || null
  };

  if (!product.categoryId || !product.productName || !product.description) {
    return { error: 'Enter a product name, description and valid category.' };
  }
  if (body.storefront_placement && !product.storefrontPlacement) {
    return { error: 'Choose a valid storefront placement.' };
  }
  if (!isExisting && !product.storefrontPlacement) {
    return { error: 'Choose where this product should appear in the storefront.' };
  }
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(price)) {
    return { error: 'Enter a price from 0 to 99,999,999.99 with no more than two decimal places.' };
  }
  if (!/^\d{1,7}$/.test(stock) || product.stockQuantity > 1000000) {
    return { error: 'Enter a valid stock quantity between 0 and 1,000,000.' };
  }
  if (!speciesSuitability.length || speciesSuitability.length > 20 ||
      speciesSuitability.some(species => species.length > 50)) {
    return { error: 'Select one or more supported animal species.' };
  }
  if (ageSelection !== undefined && !['none', 'range'].includes(ageSelection)) {
    return { error: 'Choose a valid age suitability option.' };
  }
  if (ageSelection === 'range' && minimumAge === null && maximumAge === null) {
    return { error: 'Enter at least one suitable age bound in months.' };
  }
  if (!reviewStatuses.includes(product.internalReviewStatus) ||
      !safetyStatuses.includes(product.safetyReviewStatus)) {
    return { error: 'Choose valid internal and safety review statuses.' };
  }
  if (minimumAge !== null && (!Number.isInteger(minimumAge) || minimumAge < 0 || minimumAge > 65535) ||
      maximumAge !== null && (!Number.isInteger(maximumAge) || maximumAge < 0 || maximumAge > 65535) ||
      minimumAge !== null && maximumAge !== null && maximumAge < minimumAge) {
    return { error: 'Enter a valid age range in months.' };
  }
  if (expiryDate) {
    const dateMatch = expiryDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) return { error: 'Enter the expiry date in a valid date format.' };
    const [, year, month, day] = dateMatch.map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return { error: 'Enter a real calendar date for expiry.' };
    }
  }
  if (product.isActive && product.internalReviewStatus !== 'approved_for_internal_listing') {
    return { error: 'A product can only be made active after Pomi approves it for internal listing.' };
  }
  if (product.isActive && product.safetyReviewStatus !== 'cleared') {
    return { error: 'A product with an unresolved safety review cannot be made active.' };
  }
  if (product.isPrescriptionProduct) {
    return { error: 'Prescription medicines are not permitted in this CA1 Pet Shop.' };
  }
  product.price = Number(price).toFixed(2);
  return { product };
}

function identifyImage(file) {
  const bytes = file.buffer;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: '.png', mimeType: 'image/png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: '.jpg', mimeType: 'image/jpeg' };
  }
  if (bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: '.webp', mimeType: 'image/webp' };
  }
  return null;
}

async function storeProductImages(files, productName) {
  await fs.mkdir(publicProductDirectory, { recursive: true });
  const stored = [];
  try {
    for (const file of files) {
      const format = identifyImage(file);
      if (!format || file.mimetype !== format.mimeType) {
        const error = new Error('Each product image must have a valid JPEG, PNG or WebP file signature.');
        error.code = 'INVALID_PRODUCT_IMAGE_CONTENT';
        throw error;
      }
      const filename = `${randomUUID()}${format.extension}`;
      const absolutePath = path.join(publicProductDirectory, filename);
      await fs.writeFile(absolutePath, file.buffer, { flag: 'wx', mode: 0o644 });
      stored.push({
        absolutePath,
        imagePath: `/images/products/${filename}`,
        altText: `${productName} product photograph`
      });
    }
    return stored;
  } catch (error) {
    await Promise.all(stored.map(file => fs.unlink(file.absolutePath).catch(cleanupError => {
      if (cleanupError.code !== 'ENOENT') {
        console.error('Incomplete product image cleanup:', cleanupError.code || 'UNKNOWN');
      }
    })));
    throw error;
  } finally {
    for (const file of files) file.buffer = undefined;
  }
}

async function cleanupStoredImages(files) {
  await Promise.all(files.map(file => fs.unlink(file.absolutePath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  })));
}

async function storeProductDocuments(files) {
  const stored = [];
  try {
    for (const file of files) {
      stored.push(await privatePetShopStorage.storePdfDocument(file));
    }
    return stored;
  } catch (error) {
    await Promise.all(stored.map(async document => {
      try {
        await privatePetShopStorage.removePdfDocument(document.storageKey);
      } catch (cleanupError) {
        console.error('Incomplete private product document cleanup:', cleanupError.code || 'UNKNOWN');
      }
    }));
    throw error;
  } finally {
    for (const file of files) file.buffer = undefined;
  }
}

async function cleanupStoredDocuments(documents) {
  await Promise.all(documents.map(document =>
    privatePetShopStorage.removePdfDocument(document.storageKey)
  ));
}

async function logProductAction(req, actionType, productId, productName) {
  try {
    await adminActivityModel.logAdminAction({
      adminId: req.session.user.id,
      adminUsername: req.session.user.username,
      adminName: req.session.user.name || req.session.user.username,
      actionType,
      targetEntityType: 'pet_shop_product',
      targetEntityId: productId,
      actionResult: 'success',
      metadata: { summary: `${productName} ${actionType === 'PET_SHOP_PRODUCT_CREATED' ? 'created' : 'updated'}` }
    });
  } catch (error) {
    console.error('Pet Shop admin audit logging failed:', error.code || 'UNKNOWN');
  }
}

function formatProduct(product) {
  return {
    ...product,
    species_suitability: Array.isArray(product.species_suitability)
      ? product.species_suitability
      : typeof product.species_suitability === 'string'
        ? JSON.parse(product.species_suitability)
        : []
  };
}

async function renderCatalog(req, res, options = {}) {
  const template = options.brandCode
    ? 'petShopBrand'
    : options.categoryCode
      ? 'petShopCollection'
      : 'petShop';
  const featureReady = await petShopModel.isFeatureReady();
  if (!featureReady) {
    return res.status(503).render(template, {
      session: req.session,
      csrfToken: req.session.csrfToken,
      migrationReady: false,
      categories: [],
      collection: null,
      brand: null,
      trustedBrands: [],
      speciesOptions: [],
      priceRanges,
      products: [],
      filters: {},
      pets: [],
      selectedPet: null,
      errorMessage: options.errorMessage || null,
      successMessage: req.flash('success')[0] || null
    });
  }

  const categories = (await petShopModel.getCategories()).map(item => ({
    ...item,
    imageUrl: item.image_path || categoryPhotography[item.category_code]
  }));
  const brand = options.brandCode
    ? await petShopModel.getTrustedBrandByCode(options.brandCode)
    : null;
  if (options.brandCode && !brand) return res.status(404).send('Trusted brand not found.');
  const collection = options.categoryCode
    ? categories.find(item => item.category_code === options.categoryCode)
    : null;
  if (options.categoryCode && !collection) return res.status(404).send('Collection not found.');
  const rawFilters = req.query || {};
  for (const field of ['search', 'category', 'species', 'price_range', 'age_category', 'max_price']) {
    if (rawFilters[field] !== undefined && typeof rawFilters[field] !== 'string') {
      return res.status(400).send('Choose valid shop filters.');
    }
  }
  const search = getText(rawFilters.search, 100);
  const category = options.categoryCode || getText(rawFilters.category, 60);
  let species = getText(rawFilters.species, 50);
  const maxPriceValue = typeof rawFilters.max_price === 'string' ? rawFilters.max_price.trim() : '';
  const maxPrice = maxPriceValue && /^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(maxPriceValue)
    ? Number(maxPriceValue)
    : null;
  const priceRange = getText(rawFilters.price_range, 20);
  const ageCategory = getText(rawFilters.age_category, 30);
  const supportedPriceRanges = new Set(priceRanges.map(range => range.value).filter(Boolean));
  if (priceRange && !supportedPriceRanges.has(priceRange)) {
    return res.status(400).send('Choose a valid price range.');
  }
  if (ageCategory && !['age-limited', 'no-age-limit'].includes(ageCategory)) {
    return res.status(400).send('Choose a valid age category.');
  }
  const availableOnly = rawFilters.availability === 'available';
  const filters = {
    search,
    category,
    species,
    maxPrice: maxPriceValue,
    priceRange,
    ageCategory,
    availableOnly
  };
  const storefrontPlacement = options.brandCode
    ? brand.storefront_group === 'cats_dogs' ? 'trusted_cats_dogs' : 'trusted_small_furries'
    : options.categoryCode
      ? null
      : 'pethub_products';
  const [trustedBrands, speciesOptions] = await Promise.all([
    petShopModel.getTrustedBrands(),
    petShopModel.getStorefrontSpecies({
      storefrontPlacement,
      brandId: brand ? brand.id : null
    })
  ]);
  if (species && !speciesOptions.some(option => option.toLowerCase() === species.toLowerCase())) {
    return res.status(400).send('Choose an animal species represented by the listed products.');
  }
  const pets = req.session.user && req.session.user.role === 'user'
    ? await petShopModel.getOwnerPets(req.session.user.id)
    : [];
  let selectedPet = null;
  let petAgeMonths;
  if (rawFilters.pet_id) {
    const petId = parseId(rawFilters.pet_id);
    selectedPet = petId && req.session.user && req.session.user.role === 'user'
      ? await petShopModel.getOwnerPet(req.session.user.id, petId)
      : null;
    if (!selectedPet) {
      return res.status(404).render(template, {
        session: req.session,
        csrfToken: req.session.csrfToken,
        migrationReady: true,
        categories,
        collection,
        products: [],
        filters,
        pets,
        selectedPet: null,
        errorMessage: 'That pet is not available in your account.',
        successMessage: req.flash('success')[0] || null
      });
    }
    species = selectedPet.species;
    petAgeMonths = Number(selectedPet.age) * 12;
    filters.species = species;
    filters.petId = selectedPet.id;
  }

  const products = (await petShopModel.listProducts({
    search,
    category,
    species,
    petAgeMonths,
    maxPrice,
    priceRange,
    ageCategory,
    availableOnly,
    storefrontPlacement,
    brandId: brand ? brand.id : null,
    userId: req.session.user && req.session.user.role === 'user'
      ? req.session.user.id
      : 0
  })).map(formatProduct);
  return res.render(template, {
    session: req.session,
    csrfToken: req.session.csrfToken,
    migrationReady: true,
    categories,
    collection,
    brand,
    trustedBrands,
    speciesOptions,
    priceRanges,
    returnTo: req.originalUrl,
    products,
    productCount: products.length,
    filters,
    pets,
    selectedPet,
    errorMessage: options.errorMessage || null,
    successMessage: req.flash('success')[0] || null
  });
}

async function listCatalog(req, res) {
  try {
    return await renderCatalog(req, res);
  } catch (error) {
    if (error.code === 'PET_SHOP_MIGRATION_REQUIRED') {
      return res.status(503).render('petShop', {
        session: req.session,
        csrfToken: req.session.csrfToken,
        migrationReady: false,
        categories: [],
        products: [],
        filters: {},
        pets: [],
        selectedPet: null,
        errorMessage: null,
        successMessage: null,
        trustedBrands: [],
        speciesOptions: [],
        priceRanges,
        returnTo: '/shop'
      });
    }
    if (process.env.NODE_ENV === 'production') {
      console.error('Pet Shop catalogue could not be loaded:', error.code || 'UNKNOWN');
    } else {
      console.error('Pet Shop catalogue could not be loaded:', error);
    }
    return res.status(503).render('petShop', {
      session: req.session,
      csrfToken: req.session.csrfToken,
      migrationReady: true,
      categories: [],
      trustedBrands: [],
      speciesOptions: [],
      priceRanges,
      products: [],
      filters: {},
      pets: [],
      selectedPet: null,
      returnTo: '/shop',
      catalogueErrorMessage: 'The collection is temporarily unavailable. Please try again in a little while.',
      errorMessage: null,
      successMessage: null
    });
  }
}

async function viewCollection(req, res) {
  const categoryCode = getText(req.params.categoryCode, 60);
  try {
    return await renderCatalog(req, res, { categoryCode });
  } catch (error) {
    if (error.code === 'PET_SHOP_MIGRATION_REQUIRED') {
      return res.status(503).render('petShopCollection', {
        session: req.session,
        csrfToken: req.session.csrfToken,
        migrationReady: false,
        categories: [],
        collection: null,
        products: [],
        filters: {},
        pets: [],
        selectedPet: null,
        errorMessage: null,
        successMessage: null
      });
    }
    console.error('Pet Shop collection could not be loaded:', error.code || 'UNKNOWN');
    return res.status(503).render('petShopCollection', {
      session: req.session,
      csrfToken: req.session.csrfToken,
      migrationReady: true,
      categories: [],
      collection: null,
      products: [],
      filters: {},
      pets: [],
      selectedPet: null,
      catalogueErrorMessage: 'This collection is temporarily unavailable. Please try again in a little while.',
      errorMessage: null,
      successMessage: null
    });
  }
}

async function viewBrand(req, res) {
  const brandCode = getText(req.params.brandCode, 60);
  try {
    return await renderCatalog(req, res, { brandCode });
  } catch (error) {
    if (error.code === 'PET_SHOP_MIGRATION_REQUIRED') {
      return res.status(503).render('petShopBrand', {
        session: req.session,
        csrfToken: req.session.csrfToken,
        migrationReady: false,
        categories: [],
        brand: null,
        trustedBrands: [],
        speciesOptions: [],
        priceRanges,
        products: [],
        filters: {},
        errorMessage: null
      });
    }
    console.error('Trusted brand products could not be loaded:', error.code || 'UNKNOWN');
    return res.status(503).send('This brand page is temporarily unavailable. Please try again in a little while.');
  }
}

async function viewProduct(req, res) {
  const productId = parseId(req.params.id);
  if (!productId) return res.status(404).send('Product not found.');
  try {
    const featureReady = await petShopModel.isFeatureReady();
    if (!featureReady) return res.status(503).send('Pet Shop is unavailable until its reviewed database migration is applied.');
    const userId = req.session.user && req.session.user.role === 'user'
      ? req.session.user.id
      : 0;
    const product = await petShopModel.getProduct(productId, userId);
    if (!product) return res.status(404).send('Product not found.');
    if (userId) await petShopModel.recordRecentlyViewed(userId, productId);
    return res.render('petShopProduct', {
      session: req.session,
      csrfToken: req.session.csrfToken,
      product: formatProduct(product),
      errorMessage: req.flash('error')[0] || null,
      successMessage: req.flash('success')[0] || null
    });
  } catch (error) {
    console.error('Pet Shop product could not be loaded:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load this product right now.');
  }
}

function safeShopReturnTo(value, fallback) {
  if (typeof value !== 'string' || !(value.startsWith('/shop') || value === '/dashboard') ||
      value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    return fallback;
  }
  return value;
}

async function setFavourite(req, res) {
  const productId = parseId(req.params.id);
  const action = req.body && req.body.action;
  const shouldFavourite = action === 'add';
  const fallback = productId ? `/shop/products/${productId}` : '/shop';
  if (!productId || !['add', 'remove'].includes(action)) {
    req.flash('error', 'Choose a valid favourite action.');
    return res.redirect('/shop');
  }
  try {
    await petShopModel.setFavourite(req.session.user.id, productId, shouldFavourite);
    req.flash('success', shouldFavourite ? 'Product added to favourites.' : 'Product removed from favourites.');
  } catch (error) {
    if (error.code !== 'PRODUCT_UNAVAILABLE' && error.code !== 'PET_SHOP_MIGRATION_REQUIRED') {
      console.error('Pet Shop favourite could not be updated:', error.code || 'UNKNOWN');
    }
    req.flash('error', error.code === 'PRODUCT_UNAVAILABLE'
      ? 'This product is no longer available to favourite.'
      : 'Unable to update your favourites right now.');
  }
  return res.redirect(safeShopReturnTo(req.body && req.body.return_to, fallback));
}

async function clearRecentlyViewed(req, res) {
  try {
    await petShopModel.clearRecentlyViewed(req.session.user.id);
    req.flash('success', 'Recently viewed products cleared.');
  } catch (error) {
    console.error('Recently viewed products could not be cleared:', error.code || 'UNKNOWN');
    req.flash('error', 'Unable to clear recently viewed products right now.');
  }
  return res.redirect('/dashboard');
}

async function viewCart(req, res) {
  try {
    const featureReady = await petShopModel.isFeatureReady();
    if (!featureReady) {
      return res.status(503).render('petShopCart', {
        session: req.session,
        migrationReady: false,
        items: [],
        totalSgd: '0.00',
        csrfToken: req.session.csrfToken,
        errorMessage: req.flash('error')[0] || null,
        successMessage: req.flash('success')[0] || null
      });
    }
    const items = await petShopModel.getCart(req.session.user.id);
    let totalCents = 0;
    const cartItems = items.map(item => {
      const priceCents = Math.round(Number(item.price_sgd) * 100);
      const subtotalCents = priceCents * Number(item.quantity);
      if (!item.availabilityError) totalCents += subtotalCents;
      return {
        ...item,
        subtotalSgd: (subtotalCents / 100).toFixed(2),
        availabilityMessage: item.availabilityError
          ? 'This item is currently unavailable. Remove it to continue.'
          : null
      };
    });
    return res.render('petShopCart', {
      session: req.session,
      migrationReady: true,
      items: cartItems,
      totalSgd: (totalCents / 100).toFixed(2),
      csrfToken: req.session.csrfToken,
      errorMessage: req.flash('error')[0] || null,
      successMessage: req.flash('success')[0] || null
    });
  } catch (error) {
    console.error('Pet Shop cart could not be loaded:', error.code || 'UNKNOWN');
    return res.status(error.code === 'PET_SHOP_MIGRATION_REQUIRED' ? 503 : 500)
      .send('Unable to load your cart right now.');
  }
}

function cartErrorMessage(code) {
  const messages = {
    PRODUCT_UNAVAILABLE: 'This product is inactive or unavailable.',
    PRODUCT_NOT_APPROVED: 'This product has not been approved for internal listing.',
    PRESCRIPTION_PRODUCT_NOT_ALLOWED: 'Prescription medicines are not available in the CA1 Pet Shop.',
    PRODUCT_SAFETY_REVIEW_REQUIRED: 'This product has unresolved safety review concerns.',
    PRODUCT_EXPIRED: 'This product is expired and cannot be added to your cart.',
    INSUFFICIENT_STOCK: 'The requested quantity exceeds the available stock.',
    PET_SHOP_MIGRATION_REQUIRED: 'The Pet Shop is unavailable until its reviewed database migration is applied.'
  };
  return messages[code] || 'Unable to update your cart. Please try again.';
}

async function addToCart(req, res) {
  const productId = parseId(req.params.id);
  const quantity = typeof req.body.quantity === 'string' && /^\d{1,3}$/.test(req.body.quantity)
    ? Number(req.body.quantity)
    : NaN;
  if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    req.flash('error', 'Choose a valid product and quantity between 1 and 99.');
    return res.redirect('/shop');
  }
  try {
    await petShopModel.addToCart(req.session.user.id, productId, quantity);
    req.flash('success', 'Added to your cart.');
    return res.redirect('/cart');
  } catch (error) {
    if (!cartErrorMessage(error.code).startsWith('This product') &&
        error.code !== 'PRESCRIPTION_PRODUCT_NOT_ALLOWED' &&
        error.code !== 'INSUFFICIENT_STOCK' &&
        error.code !== 'PET_SHOP_MIGRATION_REQUIRED') {
      console.error('Pet Shop item could not be added:', error.code || 'UNKNOWN');
    }
    req.flash('error', cartErrorMessage(error.code));
    return res.redirect(`/shop/products/${productId}`);
  }
}

async function updateCartItem(req, res) {
  const itemId = parseId(req.params.itemId);
  const quantity = typeof req.body.quantity === 'string' && /^\d{1,3}$/.test(req.body.quantity)
    ? Number(req.body.quantity)
    : NaN;
  if (!itemId || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    req.flash('error', 'Choose a quantity between 1 and 99.');
    return res.redirect('/cart');
  }
  try {
    const updated = await petShopModel.updateCartItem(req.session.user.id, itemId, quantity);
    if (!updated) req.flash('error', 'That cart item is no longer available.');
    else req.flash('success', 'Cart quantity updated.');
  } catch (error) {
    if (!['PRODUCT_UNAVAILABLE', 'PRODUCT_NOT_APPROVED', 'PRESCRIPTION_PRODUCT_NOT_ALLOWED',
      'PRODUCT_SAFETY_REVIEW_REQUIRED', 'PRODUCT_EXPIRED', 'INSUFFICIENT_STOCK',
      'PET_SHOP_MIGRATION_REQUIRED'].includes(error.code)) {
      console.error('Pet Shop cart quantity could not be updated:', error.code || 'UNKNOWN');
    }
    req.flash('error', cartErrorMessage(error.code));
  }
  return res.redirect('/cart');
}

async function removeCartItem(req, res) {
  const itemId = parseId(req.params.itemId);
  if (!itemId) {
    req.flash('error', 'That cart item is invalid.');
    return res.redirect('/cart');
  }
  try {
    const removed = await petShopModel.removeCartItem(req.session.user.id, itemId);
    req.flash(removed ? 'success' : 'error', removed ? 'Item removed from your cart.' : 'That cart item is no longer available.');
  } catch (error) {
    if (error.code !== 'PET_SHOP_MIGRATION_REQUIRED') {
      console.error('Pet Shop cart item could not be removed:', error.code || 'UNKNOWN');
    }
    req.flash('error', cartErrorMessage(error.code));
  }
  return res.redirect('/cart');
}

async function listAdminProducts(req, res) {
  try {
    if (!(await petShopModel.isFeatureReady())) {
      return res.status(503).render('adminPetShopProducts', {
        session: req.session,
        migrationReady: false,
        products: []
      });
    }
    return res.render('adminPetShopProducts', {
      session: req.session,
      migrationReady: true,
      products: await petShopModel.getProductsForAdmin()
    });
  } catch (error) {
    console.error('Admin Pet Shop products could not be loaded:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to load product management right now.');
  }
}

function renderProductForm(
  req,
  res,
  categories,
  product = {},
  errorMessage = null,
  status = 200,
  ageMonthStep = 1,
  formOptions = {}
) {
  return res.status(status).render('adminPetShopProductForm', {
    session: req.session,
    csrfToken: req.session.csrfToken,
    categories,
    product,
    errorMessage,
    reviewStatuses,
    safetyStatuses,
    ageMonthStep,
    speciesOptions: formOptions.speciesOptions || [],
    brandSuggestions: formOptions.brandSuggestions || [],
    trustedBrands: formOptions.trustedBrands || [],
    storefrontPlacements
  });
}

async function newProductForm(req, res) {
  try {
    const [categories, ageMonthStep, speciesOptions, brandSuggestions, trustedBrands] = await Promise.all([
      petShopModel.getAdminCategories(),
      petShopModel.getProductAgeMonthStep(),
      petShopModel.getSpeciesOptions(),
      petShopModel.getBrandSuggestions(),
      petShopModel.getTrustedBrands()
    ]);
    return renderProductForm(req, res, categories, {}, null, 200, ageMonthStep, {
      speciesOptions,
      brandSuggestions,
      trustedBrands
    });
  } catch (error) {
    console.error('Pet Shop product form could not be loaded:', error.code || 'UNKNOWN');
    return res.status(error.code === 'PET_SHOP_MIGRATION_REQUIRED' ? 503 : 500)
      .send('Product management is unavailable right now.');
  }
}

async function editProductForm(req, res) {
  const productId = parseId(req.params.id);
  if (!productId) return res.status(404).send('Product not found.');
  try {
    const [categories, product, ageMonthStep, speciesOptions, brandSuggestions, trustedBrands] = await Promise.all([
      petShopModel.getAdminCategories(),
      petShopModel.getProductForAdmin(productId),
      petShopModel.getProductAgeMonthStep(),
      petShopModel.getSpeciesOptions(),
      petShopModel.getBrandSuggestions(),
      petShopModel.getTrustedBrands()
    ]);
    if (!product) return res.status(404).send('Product not found.');
    return renderProductForm(req, res, categories, product, null, 200, ageMonthStep, {
      speciesOptions,
      brandSuggestions,
      trustedBrands
    });
  } catch (error) {
    console.error('Pet Shop product could not be loaded for editing:', error.code || 'UNKNOWN');
    return res.status(error.code === 'PET_SHOP_MIGRATION_REQUIRED' ? 503 : 500)
      .send('Product management is unavailable right now.');
  }
}

async function saveProduct(req, res) {
  const productId = req.params.id ? parseId(req.params.id) : null;
  if (req.params.id && !productId) return res.status(404).send('Product not found.');
  const parsed = parseProductForm(req.body || {}, Boolean(productId));
  let categories;
  try {
    categories = await petShopModel.getAdminCategories();
  } catch (error) {
    console.error('Pet Shop categories could not be loaded:', error.code || 'UNKNOWN');
    return res.status(error.code === 'PET_SHOP_MIGRATION_REQUIRED' ? 503 : 500)
      .send('Product management is unavailable right now.');
  }
  const formOptions = {};
  try {
    [formOptions.speciesOptions, formOptions.brandSuggestions, formOptions.trustedBrands] = await Promise.all([
      petShopModel.getSpeciesOptions(),
      petShopModel.getBrandSuggestions(),
      petShopModel.getTrustedBrands()
    ]);
  } catch (error) {
    console.error('Pet Shop product form options could not be loaded:', error.code || 'UNKNOWN');
    return res.status(error.code === 'PET_SHOP_MIGRATION_REQUIRED' ? 503 : 500)
      .send('Product management is unavailable right now.');
  }
  if (parsed.error) {
    return renderProductForm(req, res, categories, { ...req.body, id: productId }, parsed.error, 400, 1, formOptions);
  }
  if (!categories.some(category => category.id === parsed.product.categoryId && Number(category.is_active) === 1)) {
    return renderProductForm(
      req,
      res,
      categories,
      { ...req.body, id: productId },
      'Choose an active product category.',
      400,
      1,
      formOptions
    );
  }
  if (parsed.product.speciesSuitability.some(species => !formOptions.speciesOptions.includes(species))) {
    return renderProductForm(
      req,
      res,
      categories,
      { ...req.body, id: productId },
      'Choose animal species supported by the stored product data.',
      400,
      1,
      formOptions
    );
  }
  const placementGroup = {
    trusted_cats_dogs: 'cats_dogs',
    trusted_small_furries: 'small_furries'
  }[parsed.product.storefrontPlacement];
  if (placementGroup) {
    const normalizedName = typeof parsed.product.brand === 'string'
      ? parsed.product.brand.toLocaleLowerCase('en-SG').replace(/[^\p{L}\p{N}]/gu, '')
      : '';
    let trustedBrand;
    try {
      trustedBrand = normalizedName
        ? await petShopModel.getTrustedBrandByNormalizedName(normalizedName)
        : null;
    } catch (error) {
      console.error('Trusted brand could not be validated:', error.code || 'UNKNOWN');
      return res.status(error.code === 'PET_SHOP_MIGRATION_REQUIRED' ? 503 : 500)
        .send('Product management is unavailable right now.');
    }
    if (!trustedBrand || trustedBrand.storefront_group !== placementGroup) {
      return renderProductForm(
        req,
        res,
        categories,
        { ...req.body, id: productId },
        'Choose a known trusted brand that belongs to the selected storefront group.',
        400,
        1,
        formOptions
      );
    }
    parsed.product.brand = trustedBrand.brand_name;
    parsed.product.trustedBrandId = trustedBrand.id;
  }

  let storedImages = [];
  let storedDocuments = [];
  try {
    const files = req.files || {};
    storedImages = await storeProductImages(files.images || [], parsed.product.productName);
    storedDocuments = await storeProductDocuments(files.supporting_documents || []);
    const imageFiles = storedImages.map(file => ({
      imagePath: file.imagePath,
      altText: file.altText
    }));
    const documentFiles = storedDocuments.map(document => ({
      storageKey: document.storageKey,
      filename: document.filename,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes
    }));
    const savedId = await petShopModel.saveProduct(
      { ...parsed.product, id: productId },
      req.session.user.id,
      imageFiles,
      documentFiles
    );
    await logProductAction(
      req,
      productId ? 'PET_SHOP_PRODUCT_UPDATED' : 'PET_SHOP_PRODUCT_CREATED',
      savedId,
      parsed.product.productName
    );
    req.flash('success', 'Product listing saved.');
    return res.redirect('/admin/products');
  } catch (error) {
    await cleanupStoredImages(storedImages);
    await cleanupStoredDocuments(storedDocuments);
    if (error.code === 'PRODUCT_AGE_PRECISION_NOT_SUPPORTED') {
      return renderProductForm(req, res, categories, { ...req.body, id: productId }, error.message, 400, 12, formOptions);
    }
    if (error.code === 'INVALID_PRODUCT_IMAGE_CONTENT') {
      return renderProductForm(req, res, categories, { ...req.body, id: productId }, error.message, 400, 1, formOptions);
    }
    if (error.code === 'INVALID_PRODUCT_DOCUMENT_CONTENT') {
      return renderProductForm(req, res, categories, { ...req.body, id: productId }, error.message, 400, 1, formOptions);
    }
    console.error('Pet Shop product could not be saved:', error.code || 'UNKNOWN');
    return res.status(error.code === 'PET_SHOP_MIGRATION_REQUIRED' ? 503 : 500)
      .send('Unable to save this product right now.');
  }
}

async function handleImageUploadError(req, res, error) {
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).send('Product images must be no larger than 5 MB each.');
  if (error.code === 'LIMIT_FILE_COUNT') return res.status(400).send('Upload no more than five product images at a time.');
  if (error.code === 'INVALID_PRODUCT_IMAGE_TYPE' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).send('Product images must be JPEG, PNG or WebP files.');
  }
  if (error.code === 'INVALID_PRODUCT_DOCUMENT_TYPE') {
    return res.status(400).send('Product supporting documents must be PDF files.');
  }
  console.error('Product image upload failed:', error.code || 'UNKNOWN');
  return res.status(400).send('Unable to accept these product images.');
}

async function downloadProductDocument(req, res) {
  const productId = parseId(req.params.id);
  const documentId = parseId(req.params.documentId);
  if (!productId || !documentId) return res.status(404).send('Product document not found.');
  try {
    const document = await petShopModel.getProductDocument(productId, documentId);
    if (!document) return res.status(404).send('Product document not found.');
    const bytes = await privatePetShopStorage.readPdfDocument(document.storage_key);
    const safeFilename = privatePetShopStorage.normalizeFilename(document.original_filename).replace(/["\\]/g, '_');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Length', String(bytes.length));
    res.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(bytes);
  } catch (error) {
    console.error('Private Pet Shop document could not be downloaded:', error.code || 'UNKNOWN');
    return res.status(500).send('Unable to download this supplier document right now.');
  }
}

module.exports = {
  listCatalog,
  viewCollection,
  viewBrand,
  viewProduct,
  setFavourite,
  clearRecentlyViewed,
  viewCart,
  addToCart,
  updateCartItem,
  removeCartItem,
  listAdminProducts,
  newProductForm,
  editProductForm,
  saveProduct,
  handleImageUploadError,
  downloadProductDocument
};
