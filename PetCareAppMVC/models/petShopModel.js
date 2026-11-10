const connection = require('../config/db');
const { AsyncLocalStorage } = require('async_hooks');

const database = connection && typeof connection.promise === 'function'
  ? connection.promise()
  : null;
const createTransactionConnection = connection && connection.createPetShopTransactionConnection;
const CATEGORY_TABLE = 'pet_shop_categories';
const PRODUCT_TABLE = 'pet_shop_products';
const IMAGE_TABLE = 'pet_shop_product_images';
const DOCUMENT_TABLE = 'pet_shop_product_documents';
const CART_TABLE = 'pet_shop_carts';
const CART_ITEM_TABLE = 'pet_shop_cart_items';
const BRAND_TABLE = 'pet_shop_trusted_brands';
const FAVOURITE_TABLE = 'pet_shop_user_favourites';
const RECENT_TABLE = 'pet_shop_recently_viewed';
const FEATURE_READY_CACHE_MS = 10000;
const COMMON_SPECIES = ['Cat', 'Dog', 'Rabbit', 'Guinea Pig', 'Hamster', 'Chinchilla'];
const transactionContext = new AsyncLocalStorage();
let featureReadyCachedAt = 0;

function normalizeSpecies(value) {
  const species = value.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  const canonical = COMMON_SPECIES.find(
    option => option.toLocaleLowerCase('en-SG') === species.toLocaleLowerCase('en-SG')
  );
  return canonical || species;
}

function addSpecies(speciesMap, value) {
  if (typeof value !== 'string' || !value.trim()) return;
  const species = normalizeSpecies(value);
  const key = species.toLocaleLowerCase('en-SG');
  if (!speciesMap.has(key)) speciesMap.set(key, species);
}

function query(sql, params) {
  const transactionDatabase = transactionContext.getStore();
  return (transactionDatabase || database).query(sql, params);
}

function migrationRequiredError() {
  const error = new Error('Pet Shop tables are not available. Review and apply migrations/004_add_pet_shop.sql and migrations/005_add_pet_shop_storefront_and_user_history.sql first.');
  error.code = 'PET_SHOP_MIGRATION_REQUIRED';
  return error;
}

async function isFeatureReady() {
  if (!database) return false;
  if (Date.now() - featureReadyCachedAt < FEATURE_READY_CACHE_MS) return true;
  for (const tableName of [
    CATEGORY_TABLE, PRODUCT_TABLE, IMAGE_TABLE, DOCUMENT_TABLE, CART_TABLE, CART_ITEM_TABLE,
    BRAND_TABLE, FAVOURITE_TABLE, RECENT_TABLE
  ]) {
    const [rows] = await query('SHOW TABLES LIKE ?', [tableName]);
    if (!rows.length) return false;
  }
  featureReadyCachedAt = Date.now();
  return true;
}

async function ensureFeatureReady() {
  if (!(await isFeatureReady())) throw migrationRequiredError();
}

async function getProductAgeColumns() {
  const [columns] = await query('SHOW COLUMNS FROM pet_shop_products');
  const names = new Set(columns.map(column => column.Field));
  if (names.has('minimum_age_months') && names.has('maximum_age_months')) {
    return { minimum: 'minimum_age_months', maximum: 'maximum_age_months', monthsPerUnit: 1 };
  }
  if (names.has('minimum_age_years') && names.has('maximum_age_years')) {
    return { minimum: 'minimum_age_years', maximum: 'maximum_age_years', monthsPerUnit: 12 };
  }
  const error = new Error('pet_shop_products does not contain a supported age suitability column pair.');
  error.code = 'PET_SHOP_SCHEMA_INCOMPATIBLE';
  throw error;
}

async function withTransaction(callback) {
  if (typeof createTransactionConnection !== 'function') {
    throw new Error('A dedicated MySQL connection is required for Pet Shop transactions.');
  }
  const transactionConnection = createTransactionConnection();
  const transactionDatabase = transactionConnection.promise();
  let transactionStarted = false;
  try {
    await transactionDatabase.connect();
    await transactionDatabase.beginTransaction();
    transactionStarted = true;
    const result = await transactionContext.run(transactionDatabase, callback);
    await transactionDatabase.commit();
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await transactionDatabase.rollback();
      } catch (rollbackError) {
        console.error('Pet Shop transaction rollback failed:', rollbackError.code || 'UNKNOWN');
      }
    }
    throw error;
  } finally {
    await transactionDatabase.end();
  }
}

function eligibilityError(product, quantity = 1) {
  if (!product || Number(product.is_active) !== 1) return 'PRODUCT_UNAVAILABLE';
  if (product.category_is_active !== undefined && Number(product.category_is_active) !== 1) {
    return 'PRODUCT_UNAVAILABLE';
  }
  if (product.internal_review_status !== 'approved_for_internal_listing') return 'PRODUCT_NOT_APPROVED';
  if (Number(product.is_prescription_product) === 1) return 'PRESCRIPTION_PRODUCT_NOT_ALLOWED';
  if (product.safety_review_status !== 'cleared') return 'PRODUCT_SAFETY_REVIEW_REQUIRED';
  const expiryDate = product.expiry_date instanceof Date
    ? product.expiry_date.toISOString().slice(0, 10)
    : String(product.expiry_date || '').slice(0, 10);
  const isExpired = product.is_expired === undefined
    ? Boolean(expiryDate && expiryDate < new Date().toISOString().slice(0, 10))
    : Number(product.is_expired) === 1;
  if (isExpired) {
    return 'PRODUCT_EXPIRED';
  }
  if (Number(product.stock_quantity) < quantity) return 'INSUFFICIENT_STOCK';
  return null;
}

async function getCategories() {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT c.id, c.category_code, c.category_name, c.description, c.image_path,
        COUNT(p.id) AS product_count
     FROM ${CATEGORY_TABLE} c
     LEFT JOIN ${PRODUCT_TABLE} p ON p.category_id = c.id
       AND p.is_active = 1
       AND p.internal_review_status = 'approved_for_internal_listing'
       AND p.safety_review_status = 'cleared'
       AND p.is_prescription_product = 0
       AND (p.expiry_date IS NULL OR p.expiry_date >= CURRENT_DATE)
     WHERE c.is_active = 1
     GROUP BY c.id
     ORDER BY c.id`
  );
  return rows;
}

async function getAdminCategories() {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT c.id, c.category_code, c.category_name, c.description, c.image_path, c.is_active
     FROM ${CATEGORY_TABLE} c ORDER BY c.category_name`
  );
  return rows;
}

function buildProductWhere(filters = {}, ageColumns) {
  const clauses = [
    'p.is_active = 1',
    "p.internal_review_status = 'approved_for_internal_listing'",
    "p.safety_review_status = 'cleared'",
    'p.is_prescription_product = 0',
    '(p.expiry_date IS NULL OR p.expiry_date >= CURRENT_DATE)'
  ];
  const values = [];
  if (filters.search) {
    clauses.push('(p.product_name LIKE ? OR p.brand LIKE ?)');
    values.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.category) {
    clauses.push('c.category_code = ?');
    values.push(filters.category);
  }
  if (filters.storefrontPlacement) {
    clauses.push('p.storefront_placement = ?');
    values.push(filters.storefrontPlacement);
  }
  if (filters.brandId) {
    clauses.push('p.trusted_brand_id = ?');
    values.push(filters.brandId);
  }
  if (filters.species) {
    clauses.push("JSON_SEARCH(LOWER(CAST(p.species_suitability AS CHAR)), 'one', LOWER(?)) IS NOT NULL");
    values.push(filters.species);
  }
  if (Number.isInteger(filters.petAgeMonths)) {
    clauses.push(`(p.${ageColumns.minimum} IS NULL OR p.${ageColumns.minimum} <= ?)`);
    clauses.push(`(p.${ageColumns.maximum} IS NULL OR p.${ageColumns.maximum} >= ?)`);
    const ageInStorageUnits = Math.floor(filters.petAgeMonths / ageColumns.monthsPerUnit);
    values.push(ageInStorageUnits, ageInStorageUnits);
  }
  if (filters.priceRange === 'below-20') {
    clauses.push('p.price_sgd < 20');
  } else if (filters.priceRange === '20-50') {
    clauses.push('p.price_sgd >= 20 AND p.price_sgd <= 50');
  } else if (filters.priceRange === '50-100') {
    clauses.push('p.price_sgd > 50 AND p.price_sgd <= 100');
  } else if (filters.priceRange === 'above-100') {
    clauses.push('p.price_sgd > 100');
  } else if (filters.maxPrice !== null && filters.maxPrice !== undefined) {
    clauses.push('p.price_sgd <= ?');
    values.push(filters.maxPrice);
  }
  if (filters.ageCategory === 'age-limited') {
    clauses.push(`(p.${ageColumns.minimum} IS NOT NULL OR p.${ageColumns.maximum} IS NOT NULL)`);
  } else if (filters.ageCategory === 'no-age-limit') {
    clauses.push(`p.${ageColumns.minimum} IS NULL AND p.${ageColumns.maximum} IS NULL`);
  }
  if (filters.availableOnly) clauses.push('p.stock_quantity > 0');
  return { whereClause: clauses.join(' AND '), values };
}

async function listProducts(filters = {}) {
  await ensureFeatureReady();
  const ageColumns = await getProductAgeColumns();
  const { whereClause, values } = buildProductWhere(filters, ageColumns);
  const minimumAgeProjection = ageColumns.monthsPerUnit === 1
    ? `p.${ageColumns.minimum} AS minimum_age_months`
    : `p.${ageColumns.minimum} * 12 AS minimum_age_months`;
  const maximumAgeProjection = ageColumns.monthsPerUnit === 1
    ? `p.${ageColumns.maximum} AS maximum_age_months`
    : `p.${ageColumns.maximum} * 12 AS maximum_age_months`;
  const [rows] = await query(
    `SELECT p.id, p.product_name, p.brand, p.description, p.price_sgd,
        p.stock_quantity, p.species_suitability,
        ${minimumAgeProjection}, ${maximumAgeProjection},
        c.category_code, c.category_name, p.storefront_placement, p.trusted_brand_id,
        EXISTS(SELECT 1 FROM ${FAVOURITE_TABLE} f
          WHERE f.user_id = ? AND f.product_id = p.id) AS is_favourite,
        (SELECT i.image_path FROM ${IMAGE_TABLE} i
         WHERE i.product_id = p.id ORDER BY i.sort_order, i.id LIMIT 1) AS image_path
     FROM ${PRODUCT_TABLE} p
     JOIN ${CATEGORY_TABLE} c ON c.id = p.category_id
     WHERE c.is_active = 1 AND ${whereClause}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 100`,
    [Number(filters.userId) || 0, ...values]
  );
  return rows;
}

async function getProduct(productId, userId = 0) {
  await ensureFeatureReady();
  const ageColumns = await getProductAgeColumns();
  const ageProjections = ageColumns.monthsPerUnit === 1
    ? ''
    : `, p.${ageColumns.minimum} * 12 AS minimum_age_months,
       p.${ageColumns.maximum} * 12 AS maximum_age_months`;
  const [rows] = await query(
    `SELECT p.*${ageProjections}, c.category_code, c.category_name,
        b.brand_code AS trusted_brand_code, b.brand_name AS trusted_brand_name,
        EXISTS(SELECT 1 FROM ${FAVOURITE_TABLE} f
          WHERE f.user_id = ? AND f.product_id = p.id) AS is_favourite,
        (SELECT i.image_path FROM ${IMAGE_TABLE} i
         WHERE i.product_id = p.id ORDER BY i.sort_order, i.id LIMIT 1) AS image_path
     FROM ${PRODUCT_TABLE} p
     JOIN ${CATEGORY_TABLE} c ON c.id = p.category_id
     LEFT JOIN ${BRAND_TABLE} b ON b.id = p.trusted_brand_id
     WHERE p.id = ?
       AND p.is_active = 1
       AND p.internal_review_status = 'approved_for_internal_listing'
       AND p.safety_review_status = 'cleared'
       AND p.is_prescription_product = 0
       AND c.is_active = 1
       AND (p.expiry_date IS NULL OR p.expiry_date >= CURRENT_DATE)
     LIMIT 1`,
    [Number(userId) || 0, productId]
  );
  if (!rows.length) return null;
  const product = rows[0];
  const [images] = await query(
    `SELECT image_path, alt_text FROM ${IMAGE_TABLE}
     WHERE product_id = ? ORDER BY sort_order, id`,
    [productId]
  );
  product.images = images;
  return product;
}

async function getTrustedBrands() {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT id, brand_code, brand_name, normalized_name, storefront_group, display_order
     FROM ${BRAND_TABLE}
     ORDER BY storefront_group, display_order`
  );
  return rows;
}

async function getTrustedBrandByCode(brandCode) {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT id, brand_code, brand_name, normalized_name, storefront_group, display_order
     FROM ${BRAND_TABLE} WHERE brand_code = ? LIMIT 1`,
    [brandCode]
  );
  return rows[0] || null;
}

async function getTrustedBrandByNormalizedName(normalizedName) {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT id, brand_code, brand_name, normalized_name, storefront_group, display_order
     FROM ${BRAND_TABLE} WHERE normalized_name = ? LIMIT 1`,
    [normalizedName]
  );
  return rows[0] || null;
}

async function getBrandSuggestions() {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT brand FROM ${PRODUCT_TABLE}
     WHERE brand IS NOT NULL AND TRIM(brand) <> ''
     GROUP BY brand ORDER BY brand LIMIT 100`
  );
  const trustedBrands = await getTrustedBrands();
  return [...new Set([...trustedBrands.map(brand => brand.brand_name), ...rows.map(row => row.brand)])]
    .sort((left, right) => left.localeCompare(right));
}

async function getStorefrontSpecies(filters = {}) {
  await ensureFeatureReady();
  const clauses = [
    'p.is_active = 1',
    "p.internal_review_status = 'approved_for_internal_listing'",
    "p.safety_review_status = 'cleared'",
    'p.is_prescription_product = 0',
    '(p.expiry_date IS NULL OR p.expiry_date >= CURRENT_DATE)',
    'c.is_active = 1'
  ];
  const values = [];
  if (filters.storefrontPlacement) {
    clauses.push('p.storefront_placement = ?');
    values.push(filters.storefrontPlacement);
  }
  if (filters.brandId) {
    clauses.push('p.trusted_brand_id = ?');
    values.push(filters.brandId);
  }
  const [rows] = await query(
    `SELECT p.species_suitability
     FROM ${PRODUCT_TABLE} p
     JOIN ${CATEGORY_TABLE} c ON c.id = p.category_id
     WHERE ${clauses.join(' AND ')}`,
    values
  );
  const species = new Map();
  for (const row of rows) {
    const suitability = Array.isArray(row.species_suitability)
      ? row.species_suitability
      : JSON.parse(row.species_suitability);
    for (const value of suitability) addSpecies(species, value);
  }
  return [...species.values()].sort((left, right) => left.localeCompare(right));
}

async function getSpeciesOptions() {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT species_suitability FROM ${PRODUCT_TABLE}`
  );
  const species = new Map(COMMON_SPECIES.map(value => [value.toLocaleLowerCase('en-SG'), value]));
  for (const row of rows) {
    const suitability = Array.isArray(row.species_suitability)
      ? row.species_suitability
      : JSON.parse(row.species_suitability);
    for (const value of suitability) addSpecies(species, value);
  }
  return [...species.values()].sort((left, right) => left.localeCompare(right));
}

async function getFavouriteProductIds(userId) {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT product_id FROM ${FAVOURITE_TABLE} WHERE user_id = ?`,
    [userId]
  );
  return new Set(rows.map(row => Number(row.product_id)));
}

async function setFavourite(userId, productId, shouldFavourite) {
  await ensureFeatureReady();
  if (!shouldFavourite) {
    const [result] = await query(
      `DELETE FROM ${FAVOURITE_TABLE} WHERE user_id = ? AND product_id = ?`,
      [userId, productId]
    );
    return result.affectedRows > 0;
  }
  const product = await getProduct(productId);
  if (!product) throw Object.assign(new Error('PRODUCT_UNAVAILABLE'), { code: 'PRODUCT_UNAVAILABLE' });
  await query(
    `INSERT IGNORE INTO ${FAVOURITE_TABLE} (user_id, product_id) VALUES (?, ?)`,
    [userId, productId]
  );
  return true;
}

async function getFavouriteProducts(userId) {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT p.id, p.product_name, p.brand, p.price_sgd, p.stock_quantity,
        p.is_active, p.is_prescription_product, p.internal_review_status,
        p.safety_review_status, p.expiry_date,
        c.is_active AS category_is_active,
        (p.expiry_date IS NOT NULL AND p.expiry_date < CURRENT_DATE) AS is_expired,
        (SELECT i.image_path FROM ${IMAGE_TABLE} i
         WHERE i.product_id = p.id ORDER BY i.sort_order, i.id LIMIT 1) AS image_path
     FROM ${FAVOURITE_TABLE} f
     JOIN ${PRODUCT_TABLE} p ON p.id = f.product_id
     JOIN ${CATEGORY_TABLE} c ON c.id = p.category_id
     WHERE f.user_id = ?
     ORDER BY f.created_at DESC, f.product_id DESC`,
    [userId]
  );
  return rows.map(product => ({
    ...product,
    isAvailable: eligibilityError(product) === null
  }));
}

async function recordRecentlyViewed(userId, productId) {
  await ensureFeatureReady();
  await query(
    `INSERT INTO ${RECENT_TABLE} (user_id, product_id, viewed_at)
     VALUES (?, ?, CURRENT_TIMESTAMP(6))
     ON DUPLICATE KEY UPDATE viewed_at = CURRENT_TIMESTAMP(6)`,
    [userId, productId]
  );
  const [oldRows] = await query(
    `SELECT product_id FROM ${RECENT_TABLE}
     WHERE user_id = ?
     ORDER BY viewed_at DESC, product_id DESC
     LIMIT 18446744073709551615 OFFSET 6`,
    [userId]
  );
  if (oldRows.length) {
    await query(
      `DELETE FROM ${RECENT_TABLE} WHERE user_id = ? AND product_id IN (?)`,
      [userId, oldRows.map(row => row.product_id)]
    );
  }
}

async function getRecentlyViewedProducts(userId) {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT p.id, p.product_name, p.brand, p.price_sgd, p.stock_quantity,
        p.is_active, p.is_prescription_product, p.internal_review_status,
        p.safety_review_status, p.expiry_date, r.viewed_at,
        c.is_active AS category_is_active,
        (p.expiry_date IS NOT NULL AND p.expiry_date < CURRENT_DATE) AS is_expired,
        (SELECT i.image_path FROM ${IMAGE_TABLE} i
         WHERE i.product_id = p.id ORDER BY i.sort_order, i.id LIMIT 1) AS image_path
     FROM ${RECENT_TABLE} r
     JOIN ${PRODUCT_TABLE} p ON p.id = r.product_id
     JOIN ${CATEGORY_TABLE} c ON c.id = p.category_id
     WHERE r.user_id = ?
     ORDER BY r.viewed_at DESC, r.product_id DESC
     LIMIT 6`,
    [userId]
  );
  return rows.map(product => ({
    ...product,
    isAvailable: eligibilityError(product) === null
  }));
}

async function clearRecentlyViewed(userId) {
  await ensureFeatureReady();
  const [result] = await query(
    `DELETE FROM ${RECENT_TABLE} WHERE user_id = ?`,
    [userId]
  );
  return result.affectedRows;
}

async function getProductsForAdmin() {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT p.id, p.product_name, p.brand, p.price_sgd, p.stock_quantity,
        p.is_active, p.internal_review_status, p.safety_review_status, p.expiry_date,
        c.category_name, p.storefront_placement, p.trusted_brand_id,
        b.brand_name AS trusted_brand_name,
        (SELECT i.image_path FROM ${IMAGE_TABLE} i
         WHERE i.product_id = p.id ORDER BY i.sort_order, i.id LIMIT 1) AS image_path
     FROM ${PRODUCT_TABLE} p
     JOIN ${CATEGORY_TABLE} c ON c.id = p.category_id
     LEFT JOIN ${BRAND_TABLE} b ON b.id = p.trusted_brand_id
     ORDER BY p.updated_at DESC, p.id DESC`
  );
  return rows;
}

async function getProductForAdmin(productId) {
  await ensureFeatureReady();
  const ageColumns = await getProductAgeColumns();
  const ageProjections = ageColumns.monthsPerUnit === 1
    ? ''
    : `, p.${ageColumns.minimum} * 12 AS minimum_age_months,
       p.${ageColumns.maximum} * 12 AS maximum_age_months`;
  const [rows] = await query(
    `SELECT p.*${ageProjections}, b.brand_name AS trusted_brand_name
     FROM ${PRODUCT_TABLE} p
     LEFT JOIN ${BRAND_TABLE} b ON b.id = p.trusted_brand_id
     WHERE p.id = ? LIMIT 1`,
    [productId]
  );
  if (!rows.length) return null;
  const product = rows[0];
  const [images] = await query(
    `SELECT id, image_path, alt_text, sort_order FROM ${IMAGE_TABLE}
     WHERE product_id = ? ORDER BY sort_order, id`,
    [productId]
  );
  const [documents] = await query(
    `SELECT id, original_filename, document_title, mime_type, size_bytes, created_at
     FROM ${DOCUMENT_TABLE} WHERE product_id = ? ORDER BY created_at DESC, id DESC`,
    [productId]
  );
  product.images = images;
  product.documents = documents;
  if (typeof product.species_suitability === 'string') {
    product.species_suitability = JSON.parse(product.species_suitability);
  }
  return product;
}

async function saveProduct(product, adminId, imageFiles = [], documentFiles = []) {
  await ensureFeatureReady();
  const ageColumns = await getProductAgeColumns();
  const ageValues = [product.minimumAgeMonths, product.maximumAgeMonths].map(value => {
    if (value === null || value === undefined) return null;
    if (value % ageColumns.monthsPerUnit !== 0) {
      const error = new Error(
        'The installed Pet Shop schema supports age suitability only in whole years. Use age values in 12-month increments.'
      );
      error.code = 'PRODUCT_AGE_PRECISION_NOT_SUPPORTED';
      throw error;
    }
    return value / ageColumns.monthsPerUnit;
  });
  return withTransaction(async () => {
    const values = [
      product.categoryId,
      product.storefrontPlacement || null,
      product.trustedBrandId || null,
      product.productName,
      product.brand,
      product.description,
      product.intendedPurpose,
      product.price,
      product.stockQuantity,
      product.isPrescriptionProduct ? 1 : 0,
      product.isActive ? 1 : 0,
      product.internalReviewStatus,
      product.safetyReviewStatus,
      product.ingredientsMaterials,
      JSON.stringify(product.speciesSuitability),
      ...ageValues,
      product.usageInstructions,
      product.safetyWarnings,
      product.expiryDate,
      product.supplierName,
      product.supplierReference,
      product.countryOfOrigin,
      product.supportingDocumentReference,
      product.regulatoryAuthorityReference,
      product.submittedLicenceNumber,
      product.safetyReviewStatus === 'cleared' ? new Date() : null,
      product.safetyReviewStatus === 'cleared' ? adminId : null,
      adminId
    ];
    let productId = product.id;
    if (productId) {
      const [existingRows] = await query(
        `SELECT id FROM ${PRODUCT_TABLE} WHERE id = ? FOR UPDATE`,
        [productId]
      );
      if (!existingRows.length) {
        throw Object.assign(new Error('Product not found.'), { code: 'PRODUCT_NOT_FOUND' });
      }
      const [result] = await query(
        `UPDATE ${PRODUCT_TABLE} SET
           category_id = ?, storefront_placement = ?, trusted_brand_id = ?,
           product_name = ?, brand = ?, description = ?, intended_purpose = ?,
           price_sgd = ?, stock_quantity = ?, is_prescription_product = ?, is_active = ?, internal_review_status = ?,
           safety_review_status = ?, ingredients_materials = ?, species_suitability = ?,
           ${ageColumns.minimum} = ?, ${ageColumns.maximum} = ?, usage_instructions = ?,
           safety_warnings = ?, expiry_date = ?, supplier_name = COALESCE(?, supplier_name),
           supplier_reference = COALESCE(?, supplier_reference),
           country_of_origin = COALESCE(?, country_of_origin),
           supporting_document_reference = COALESCE(?, supporting_document_reference),
           regulatory_authority_reference = COALESCE(?, regulatory_authority_reference),
           submitted_licence_number = COALESCE(?, submitted_licence_number),
           safety_reviewed_at = ?, safety_reviewed_by_admin_id = ?, updated_by_admin_id = ?
         WHERE id = ?`,
        [...values, productId]
      );
      if (!result.affectedRows) throw Object.assign(new Error('Product not found.'), { code: 'PRODUCT_NOT_FOUND' });
    } else {
      const [result] = await query(
        `INSERT INTO ${PRODUCT_TABLE} (
          category_id, storefront_placement, trusted_brand_id, product_name, brand, description, intended_purpose, price_sgd,
          stock_quantity, is_prescription_product, is_active, internal_review_status, safety_review_status,
          ingredients_materials, species_suitability, ${ageColumns.minimum}, ${ageColumns.maximum},
          usage_instructions, safety_warnings, expiry_date, supplier_name, supplier_reference,
          country_of_origin, supporting_document_reference, regulatory_authority_reference,
          submitted_licence_number, safety_reviewed_at, safety_reviewed_by_admin_id,
          created_by_admin_id, updated_by_admin_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
        [...values, adminId]
      );
      productId = result.insertId;
    }

    for (let index = 0; index < imageFiles.length; index += 1) {
      const [orderRows] = await query(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
         FROM ${IMAGE_TABLE} WHERE product_id = ?`,
        [productId]
      );
      await query(
        `INSERT INTO ${IMAGE_TABLE} (product_id, image_path, alt_text, sort_order)
         VALUES (?, ?, ?, ?)`,
        [productId, imageFiles[index].imagePath, imageFiles[index].altText, orderRows[0].next_order]
      );
    }
    for (const document of documentFiles) {
      await query(
        `INSERT INTO ${DOCUMENT_TABLE} (
          product_id, storage_key, original_filename, document_title,
          mime_type, size_bytes, uploaded_by_admin_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          productId,
          document.storageKey,
          document.filename,
          document.filename,
          document.mimeType,
          document.sizeBytes,
          adminId
        ]
      );
    }
    return productId;
  });
}

async function getProductDocument(productId, documentId) {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT id, storage_key, original_filename, mime_type, size_bytes
     FROM ${DOCUMENT_TABLE} WHERE product_id = ? AND id = ? LIMIT 1`,
    [productId, documentId]
  );
  return rows[0] || null;
}

async function getOwnerPets(ownerId) {
  const [rows] = await query(
    "SELECT id, name, species, age FROM pets WHERE owner_id = ? AND status = 'active' ORDER BY name",
    [ownerId]
  );
  return rows;
}

async function getOwnerPet(ownerId, petId) {
  const [rows] = await query(
    "SELECT id, name, species, age FROM pets WHERE owner_id = ? AND id = ? AND status = 'active' LIMIT 1",
    [ownerId, petId]
  );
  return rows[0] || null;
}

async function getCartId(userId) {
  await query(
    `INSERT INTO ${CART_TABLE} (user_id) VALUES (?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    [userId]
  );
  const [rows] = await query(`SELECT id FROM ${CART_TABLE} WHERE user_id = ?`, [userId]);
  return rows[0].id;
}

async function getCart(userId) {
  await ensureFeatureReady();
  const cartId = await getCartId(userId);
  const [rows] = await query(
    `SELECT ci.id AS cart_item_id, ci.quantity, p.id AS product_id,
        p.product_name, p.brand, p.price_sgd, p.stock_quantity, p.is_active,
        p.is_prescription_product, c.is_active AS category_is_active,
        p.internal_review_status, p.safety_review_status, p.expiry_date,
        (p.expiry_date IS NOT NULL AND p.expiry_date < CURRENT_DATE) AS is_expired,
        (SELECT i.image_path FROM ${IMAGE_TABLE} i
         WHERE i.product_id = p.id ORDER BY i.sort_order, i.id LIMIT 1) AS image_path
     FROM ${CART_ITEM_TABLE} ci
     JOIN ${PRODUCT_TABLE} p ON p.id = ci.product_id
     JOIN ${CATEGORY_TABLE} c ON c.id = p.category_id
     WHERE ci.cart_id = ?
     ORDER BY ci.created_at DESC, ci.id DESC`,
    [cartId]
  );
  return rows.map(item => ({
    ...item,
    availabilityError: eligibilityError(item, item.quantity)
  }));
}

async function getCartCount(userId) {
  await ensureFeatureReady();
  const [rows] = await query(
    `SELECT COALESCE(SUM(ci.quantity), 0) AS item_count
     FROM ${CART_ITEM_TABLE} ci
     JOIN ${CART_TABLE} c ON c.id = ci.cart_id
     WHERE c.user_id = ?`,
    [userId]
  );
  return Number(rows[0]?.item_count || 0);
}

async function addToCart(userId, productId, quantity) {
  await ensureFeatureReady();
  return withTransaction(async () => {
    const [productRows] = await query(
      `SELECT p.id, p.is_active, p.is_prescription_product, p.internal_review_status,
          p.safety_review_status, p.stock_quantity, p.expiry_date,
          c.is_active AS category_is_active,
          (p.expiry_date IS NOT NULL AND p.expiry_date < CURRENT_DATE) AS is_expired
       FROM ${PRODUCT_TABLE} p
       JOIN ${CATEGORY_TABLE} c ON c.id = p.category_id
       WHERE p.id = ? FOR UPDATE`,
      [productId]
    );
    const productError = eligibilityError(productRows[0], quantity);
    if (productError) throw Object.assign(new Error(productError), { code: productError });

    const cartId = await getCartId(userId);
    const [itemRows] = await query(
      `SELECT id, quantity FROM ${CART_ITEM_TABLE}
       WHERE cart_id = ? AND product_id = ? FOR UPDATE`,
      [cartId, productId]
    );
    const currentQuantity = itemRows[0] ? Number(itemRows[0].quantity) : 0;
    if (currentQuantity + quantity > Number(productRows[0].stock_quantity)) {
      throw Object.assign(new Error('INSUFFICIENT_STOCK'), { code: 'INSUFFICIENT_STOCK' });
    }
    if (itemRows[0]) {
      await query(
        `UPDATE ${CART_ITEM_TABLE} SET quantity = quantity + ? WHERE id = ?`,
        [quantity, itemRows[0].id]
      );
    } else {
      await query(
        `INSERT INTO ${CART_ITEM_TABLE} (cart_id, product_id, quantity) VALUES (?, ?, ?)`,
        [cartId, productId, quantity]
      );
    }
    return true;
  });
}

async function updateCartItem(userId, itemId, quantity) {
  await ensureFeatureReady();
  return withTransaction(async () => {
    const [itemPreviewRows] = await query(
      `SELECT ci.product_id FROM ${CART_ITEM_TABLE} ci
       JOIN ${CART_TABLE} c ON c.id = ci.cart_id
       WHERE ci.id = ? AND c.user_id = ? LIMIT 1`,
      [itemId, userId]
    );
    if (!itemPreviewRows.length) return false;
    const [productRows] = await query(
      `SELECT p.id, p.is_active, p.is_prescription_product, p.internal_review_status,
          p.safety_review_status, p.stock_quantity, p.expiry_date,
          c.is_active AS category_is_active,
          (p.expiry_date IS NOT NULL AND p.expiry_date < CURRENT_DATE) AS is_expired
       FROM ${PRODUCT_TABLE} p
       JOIN ${CATEGORY_TABLE} c ON c.id = p.category_id
       WHERE p.id = ? FOR UPDATE`,
      [itemPreviewRows[0].product_id]
    );
    const productError = eligibilityError(productRows[0], quantity);
    if (productError) throw Object.assign(new Error(productError), { code: productError });
    const [itemRows] = await query(
      `SELECT ci.id, ci.product_id, ci.quantity FROM ${CART_ITEM_TABLE} ci
       JOIN ${CART_TABLE} c ON c.id = ci.cart_id
       WHERE ci.id = ? AND c.user_id = ? AND ci.product_id = ? FOR UPDATE`,
      [itemId, userId, itemPreviewRows[0].product_id]
    );
    if (!itemRows.length) return false;
    await query(
      `UPDATE ${CART_ITEM_TABLE} SET quantity = ? WHERE id = ?`,
      [quantity, itemRows[0].id]
    );
    return true;
  });
}

async function removeCartItem(userId, itemId) {
  await ensureFeatureReady();
  const [result] = await query(
    `DELETE ci FROM ${CART_ITEM_TABLE} ci
     JOIN ${CART_TABLE} c ON c.id = ci.cart_id
     WHERE ci.id = ? AND c.user_id = ?`,
    [itemId, userId]
  );
  return result.affectedRows > 0;
}

module.exports = {
  isFeatureReady,
  getProductAgeMonthStep: async () => (await getProductAgeColumns()).monthsPerUnit,
  getCategories,
  getAdminCategories,
  listProducts,
  getProduct,
  getTrustedBrands,
  getTrustedBrandByCode,
  getTrustedBrandByNormalizedName,
  getBrandSuggestions,
  getStorefrontSpecies,
  getSpeciesOptions,
  getFavouriteProductIds,
  setFavourite,
  getFavouriteProducts,
  recordRecentlyViewed,
  getRecentlyViewedProducts,
  clearRecentlyViewed,
  getProductsForAdmin,
  getProductForAdmin,
  getProductDocument,
  saveProduct,
  getOwnerPets,
  getOwnerPet,
  getCart,
  getCartCount,
  addToCart,
  updateCartItem,
  removeCartItem
};
