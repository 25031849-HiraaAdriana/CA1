const assert = require('node:assert/strict');
const { test } = require('node:test');

const statements = [];
const transactionStatements = [];
let currentProduct = {
  is_active: 1,
  is_prescription_product: 0,
  internal_review_status: 'approved_for_internal_listing',
  safety_review_status: 'cleared',
  stock_quantity: 5,
  expiry_date: null,
  category_is_active: 1
};
let ageSchema = 'months';
let cartItemExists = true;
let productInsertStarted;
let releaseProductInsert;
let pauseProductInsert = false;
const connectionPath = require.resolve('../config/db');
const modelPath = require.resolve('../models/petShopModel');
const originalConnectionModule = require.cache[connectionPath];
const originalModelModule = require.cache[modelPath];

function createMockDatabase(source) {
  const log = source === 'transaction' ? transactionStatements : statements;
  return {
    async query(sql, params = []) {
      const statement = { sql, params, source };
      log.push(statement);
      if (sql.startsWith('SHOW TABLES LIKE')) return [[{ table: 'pet_shop_tables' }]];
      if (sql === 'SHOW COLUMNS FROM pet_shop_products') {
        return ageSchema === 'months'
          ? [[{ Field: 'minimum_age_months' }, { Field: 'maximum_age_months' }]]
          : [[{ Field: 'minimum_age_years' }, { Field: 'maximum_age_years' }]];
      }
      if (sql.includes('SELECT species_suitability FROM pet_shop_products')) {
        return [[
          { species_suitability: ['guinea-pig', 'Chinchilla', 'Ferret'] },
          { species_suitability: ['ferret', 'Rabbit'] }
        ]];
      }
      if (sql.includes('SELECT p.species_suitability')) {
        return [[{
          species_suitability: ['rabbit', 'Guinea Pig', 'HAMSTER']
        }]];
      }
      if (sql.includes('SELECT c.id, c.category_code')) {
        return [[{ id: 1, category_code: 'animal-food-beverages', category_name: 'Animal Food & Beverages' }]];
      }
      if (sql.includes('SELECT p.id, p.product_name')) {
        return [[{ id: 12, product_name: 'Mock product', price_sgd: '3.25', stock_quantity: 4 }]];
      }
      if (sql.includes('WHERE owner_id = ? AND id = ?')) {
        return params[0] === 7 ? [[{ id: params[1], name: 'Luna', species: 'Cat', age: 4 }]] : [[]];
      }
      if (sql.includes('FROM pet_shop_products p') && sql.includes('FOR UPDATE')) {
        return [[{ id: params[0], ...currentProduct }]];
      }
      if (sql.includes('FROM pet_shop_products WHERE id = ? FOR UPDATE')) {
        return [[{ id: params[0] }]];
      }
      if (sql.includes('JOIN pet_shop_carts c ON c.id = ci.cart_id') && sql.includes('FOR UPDATE')) {
        return cartItemExists ? [[{ id: 45, product_id: 12, quantity: 2 }]] : [[]];
      }
      if (sql.includes('JOIN pet_shop_carts c ON c.id = ci.cart_id')) {
        return cartItemExists ? [[{ product_id: 12 }]] : [[]];
      }
      if (sql.includes('FROM pet_shop_carts WHERE user_id = ?')) return [[{ id: 31 }]];
      if (sql.includes('FROM pet_shop_cart_items') && sql.includes('FOR UPDATE')) return [[]];
      if (sql.startsWith('UPDATE pet_shop_products SET')) return [{ affectedRows: 1 }];
      if (sql.startsWith('INSERT INTO pet_shop_products')) {
        if (source === 'transaction' && pauseProductInsert) {
          pauseProductInsert = false;
          productInsertStarted();
          await new Promise(resolve => { releaseProductInsert = resolve; });
        }
        return [{ insertId: 52 }];
      }
      if (sql.startsWith('INSERT INTO pet_shop_cart_items')) return [{ affectedRows: 1 }];
      if (sql.startsWith('UPDATE pet_shop_cart_items SET')) return [{ affectedRows: 1 }];
      if (sql.startsWith('DELETE ci FROM pet_shop_cart_items')) return [{ affectedRows: 0 }];
      return [[]];
    },
    async connect() {},
    async beginTransaction() { log.push({ sql: 'BEGIN', source }); },
    async commit() { log.push({ sql: 'COMMIT', source }); },
    async rollback() { log.push({ sql: 'ROLLBACK', source }); },
    async end() {}
  };
}

const sharedDatabase = createMockDatabase('shared');
const transactionDatabase = createMockDatabase('transaction');
const mockConnection = {
  promise: () => sharedDatabase,
  createPetShopTransactionConnection: () => ({ promise: () => transactionDatabase })
};

require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: mockConnection,
  children: [],
  paths: []
};
delete require.cache[modelPath];
const petShopModel = require('../models/petShopModel');

function productFixture() {
  return {
    categoryId: 1,
    productName: 'Sample food',
    brand: null,
    description: 'A mock product.',
    intendedPurpose: null,
    price: '3.25',
    stockQuantity: 4,
    isPrescriptionProduct: false,
    isActive: false,
    internalReviewStatus: 'pending_review',
    safetyReviewStatus: 'pending',
    ingredientsMaterials: null,
    speciesSuitability: ['Cat'],
    minimumAgeMonths: 2,
    maximumAgeMonths: 12,
    usageInstructions: null,
    safetyWarnings: null,
    expiryDate: null,
    supplierName: null,
    supplierReference: null,
    countryOfOrigin: null,
    supportingDocumentReference: null,
    regulatoryAuthorityReference: null,
    submittedLicenceNumber: null
  };
}

test('catalogue queries enforce safety eligibility and filter age in months', async () => {
  ageSchema = 'months';
  const categories = await petShopModel.getCategories();
  assert.equal(categories[0].category_code, 'animal-food-beverages');

  const products = await petShopModel.listProducts({
    search: 'food',
    category: 'animal-food-beverages',
    species: 'Cat',
    petAgeMonths: 2,
    maxPrice: 20,
    availableOnly: true
  });
  assert.equal(products[0].id, 12);
  const statement = statements.find(item => item.sql.includes('SELECT p.id, p.product_name'));
  assert.match(statement.sql, /c\.is_active = 1/);
  assert.match(statement.sql, /p\.is_active = 1/);
  assert.match(statement.sql, /approved_for_internal_listing/);
  assert.match(statement.sql, /p\.safety_review_status = 'cleared'/);
  assert.match(statement.sql, /p\.is_prescription_product = 0/);
  assert.match(statement.sql, /p\.expiry_date IS NULL OR p\.expiry_date >= CURRENT_DATE/);
  assert.match(statement.sql, /JSON_SEARCH/);
  assert.match(statement.sql, /minimum_age_months/);
  assert.match(statement.sql, /maximum_age_months/);
  assert.deepEqual(statement.params, [
    0, '%food%', '%food%', 'animal-food-beverages', 'Cat', 2, 2, 20
  ]);
});

test('existing year-based schema remains readable without rerunning Migration 004', async () => {
  ageSchema = 'years';
  statements.length = 0;
  assert.equal(await petShopModel.getProductAgeMonthStep(), 12);
  await petShopModel.listProducts({ species: 'Cat', petAgeMonths: 7 });
  const listing = statements.find(item => item.sql.includes('SELECT p.id, p.product_name'));
  assert.match(listing.sql, /minimum_age_years/);
  assert.match(listing.sql, /maximum_age_years/);
  assert.match(listing.sql, /minimum_age_years IS NULL OR p\.minimum_age_years <= \?/);
  assert.deepEqual(listing.params, [0, 'Cat', 0, 0]);

  transactionStatements.length = 0;
  await petShopModel.saveProduct({
    ...productFixture(),
    minimumAgeMonths: 12,
    maximumAgeMonths: 36
  }, 7);
  const insert = transactionStatements.find(item => item.sql.startsWith('INSERT INTO pet_shop_products'));
  assert.match(insert.sql, /minimum_age_years, maximum_age_years/);
  assert.deepEqual(insert.params.slice(15, 17), [1, 3]);
  ageSchema = 'months';
});

test('storefront placement, brand, species, price and age filters compose on the server', async () => {
  statements.length = 0;
  await petShopModel.listProducts({
    userId: 29,
    search: 'kitten',
    storefrontPlacement: 'trusted_cats_dogs',
    brandId: 3,
    species: 'Cat',
    priceRange: '20-50',
    ageCategory: 'age-limited'
  });

  test('species options retain legacy values and normalize duplicate names without schema changes', async () => {
    const options = await petShopModel.getSpeciesOptions();
    assert.deepEqual(options, [
      'Cat',
      'Chinchilla',
      'Dog',
      'Ferret',
      'Guinea Pig',
      'Hamster',
      'Rabbit'
    ]);
    assert.deepEqual(await petShopModel.getStorefrontSpecies(), [
      'Guinea Pig',
      'Hamster',
      'Rabbit'
    ]);

    for (const species of ['Rabbit', 'Guinea Pig', 'Hamster']) {
      statements.length = 0;
      await petShopModel.listProducts({ species });
      const listing = statements.find(item => item.sql.includes('SELECT p.id, p.product_name'));
      assert.match(listing.sql, /JSON_SEARCH/);
      assert.ok(listing.params.includes(species));
    }
  });
  const listing = statements.find(item => item.sql.includes('SELECT p.id, p.product_name'));
  assert.match(listing.sql, /p\.storefront_placement = \?/);
  assert.match(listing.sql, /p\.trusted_brand_id = \?/);
  assert.match(listing.sql, /p\.price_sgd >= 20 AND p\.price_sgd <= 50/);
  assert.match(listing.sql, /minimum_age_months IS NOT NULL OR p\.maximum_age_months IS NOT NULL/);
  assert.match(listing.sql, /f\.user_id = \?/);
  assert.deepEqual(listing.params, [
    29, '%kitten%', '%kitten%', 'trusted_cats_dogs', 3, 'Cat'
  ]);
});

test('favourites and recently viewed queries are scoped to one owner', async () => {
  statements.length = 0;
  await petShopModel.getFavouriteProductIds(29);
  await petShopModel.getFavouriteProducts(29);
  await petShopModel.getRecentlyViewedProducts(29);
  await petShopModel.recordRecentlyViewed(29, 12);
  await petShopModel.clearRecentlyViewed(29);

  const ownerScopedQueries = statements.filter(statement =>
    statement.sql.includes('pet_shop_user_favourites') ||
    statement.sql.includes('pet_shop_recently_viewed')
  );
  assert.ok(ownerScopedQueries.length >= 5);
  for (const statement of ownerScopedQueries) {
    assert.ok(statement.params.includes(29), 'every history query receives the authenticated owner id');
  }
  const record = ownerScopedQueries.find(statement => statement.sql.startsWith('INSERT INTO pet_shop_recently_viewed'));
  assert.deepEqual(record.params, [29, 12]);
  assert.match(record.sql, /ON DUPLICATE KEY UPDATE viewed_at = CURRENT_TIMESTAMP\(6\)/);
  assert.match(ownerScopedQueries.find(statement => statement.sql.startsWith('SELECT product_id FROM pet_shop_recently_viewed')).sql, /OFFSET 6/);
});

test('year-based schema rejects month ranges it cannot represent exactly', async () => {
  ageSchema = 'years';
  await assert.rejects(
    petShopModel.saveProduct({ ...productFixture(), minimumAgeMonths: 2 }, 7),
    error => error.code === 'PRODUCT_AGE_PRECISION_NOT_SUPPORTED'
  );
  ageSchema = 'months';
});

test('registered-pet lookup is scoped to the authenticated owner', async () => {
  assert.equal((await petShopModel.getOwnerPet(7, 4)).name, 'Luna');
  assert.equal(await petShopModel.getOwnerPet(8, 4), null);
  const ownerQuery = statements.filter(item => item.sql.includes('WHERE owner_id = ? AND id = ?')).at(-1);
  assert.deepEqual(ownerQuery.params, [8, 4]);
});

test('cart add validates stock within an isolated transaction', async () => {
  transactionStatements.length = 0;
  currentProduct = { ...currentProduct, stock_quantity: 5 };
  await petShopModel.addToCart(7, 12, 2);
  assert.ok(transactionStatements.some(item => item.sql === 'BEGIN'));
  assert.ok(transactionStatements.some(item => item.sql.startsWith('INSERT INTO pet_shop_cart_items')));
  assert.ok(transactionStatements.some(item => item.sql === 'COMMIT'));

  transactionStatements.length = 0;
  currentProduct = { ...currentProduct, stock_quantity: 1 };
  await assert.rejects(petShopModel.addToCart(7, 12, 2), error => error.code === 'INSUFFICIENT_STOCK');
  assert.ok(transactionStatements.some(item => item.sql === 'ROLLBACK'));
  assert.equal(transactionStatements.some(item => item.sql.startsWith('INSERT INTO pet_shop_cart_items')), false);
});

test('cart quantity updates lock products before cart items', async () => {
  currentProduct = {
    is_active: 1,
    is_prescription_product: 0,
    internal_review_status: 'approved_for_internal_listing',
    safety_review_status: 'cleared',
    stock_quantity: 5,
    expiry_date: null,
    category_is_active: 1,
    is_expired: 0
  };
  cartItemExists = true;
  transactionStatements.length = 0;
  assert.equal(await petShopModel.updateCartItem(7, 45, 2), true);
  const productLockIndex = transactionStatements.findIndex(item =>
    item.sql.includes('FROM pet_shop_products p') && item.sql.includes('FOR UPDATE')
  );
  const itemLockIndex = transactionStatements.findIndex(item =>
    item.sql.includes('JOIN pet_shop_carts c ON c.id = ci.cart_id') &&
    item.sql.includes('FOR UPDATE')
  );
  assert.ok(productLockIndex >= 0);
  assert.ok(itemLockIndex > productLockIndex);
  assert.ok(transactionStatements.some(item => item.sql.startsWith('UPDATE pet_shop_cart_items')));
  cartItemExists = false;
});

test('cart add and quantity updates reject unsafe products and insufficient stock', async () => {
  const invalidProducts = [
    [{ is_active: 0 }, 'PRODUCT_UNAVAILABLE'],
    [{ is_prescription_product: 1 }, 'PRESCRIPTION_PRODUCT_NOT_ALLOWED'],
    [{ internal_review_status: 'pending_review' }, 'PRODUCT_NOT_APPROVED'],
    [{ safety_review_status: 'concern' }, 'PRODUCT_SAFETY_REVIEW_REQUIRED'],
    [{ is_expired: 1 }, 'PRODUCT_EXPIRED'],
    [{ category_is_active: 0 }, 'PRODUCT_UNAVAILABLE'],
    [{ stock_quantity: 1 }, 'INSUFFICIENT_STOCK']
  ];

  for (const [changes, code] of invalidProducts) {
    currentProduct = {
      is_active: 1,
      is_prescription_product: 0,
      internal_review_status: 'approved_for_internal_listing',
      safety_review_status: 'cleared',
      stock_quantity: 5,
      expiry_date: null,
      category_is_active: 1,
      ...changes
    };
    transactionStatements.length = 0;
    await assert.rejects(petShopModel.addToCart(7, 12, 2), error => error.code === code);
    assert.ok(transactionStatements.some(item => item.sql === 'ROLLBACK'));

    transactionStatements.length = 0;
    cartItemExists = true;
    await assert.rejects(petShopModel.updateCartItem(7, 45, 2), error => error.code === code);
    assert.ok(transactionStatements.some(item => item.sql === 'ROLLBACK'));
    assert.equal(transactionStatements.some(item => item.sql.startsWith('UPDATE pet_shop_cart_items')), false);
  }
  cartItemExists = false;
});

test('cart item removal is constrained by its owner', async () => {
  statements.length = 0;
  assert.equal(await petShopModel.removeCartItem(99, 45), false);
  const removal = statements.find(item => item.sql.startsWith('DELETE ci FROM pet_shop_cart_items'));
  assert.deepEqual(removal.params, [45, 99]);
});

test('new and existing product saves match SQL placeholders and use a transaction', async () => {
  const product = productFixture();
  transactionStatements.length = 0;
  assert.equal(await petShopModel.saveProduct(product, 7), 52);
  const insert = transactionStatements.find(item => item.sql.startsWith('INSERT INTO pet_shop_products'));
  assert.equal((insert.sql.match(/\?/g) || []).length, insert.params.length);
  assert.equal(insert.params[15], 2);
  assert.equal(insert.params[16], 12);
  assert.ok(transactionStatements.some(item => item.sql === 'COMMIT'));

  transactionStatements.length = 0;
  assert.equal(await petShopModel.saveProduct({ ...product, id: 52 }, 7), 52);
  const update = transactionStatements.find(item => item.sql.startsWith('UPDATE pet_shop_products SET'));
  assert.equal((update.sql.match(/\?/g) || []).length, update.params.length);
  for (const column of [
    'supplier_name',
    'supplier_reference',
    'country_of_origin',
    'supporting_document_reference',
    'regulatory_authority_reference',
    'submitted_licence_number'
  ]) {
    assert.ok(update.sql.includes(`${column} = COALESCE(?, ${column})`));
  }
  assert.ok(transactionStatements.some(item => item.sql === 'COMMIT'));
});

test('shop transaction queries use a dedicated connection while unrelated queries stay shared', async () => {
  transactionStatements.length = 0;
  statements.length = 0;
  const insertStarted = new Promise(resolve => { productInsertStarted = resolve; });
  pauseProductInsert = true;
  const productSave = petShopModel.saveProduct(productFixture(), 7);
  await insertStarted;
  await petShopModel.getOwnerPet(7, 4);
  assert.ok(statements.some(item =>
    item.source === 'shared' && item.sql.includes('WHERE owner_id = ? AND id = ?')
  ));
  assert.ok(transactionStatements.some(item => item.sql.startsWith('INSERT INTO pet_shop_products')));
  releaseProductInsert();
  await productSave;
});

test.after(() => {
  ageSchema = 'months';
  if (originalConnectionModule) require.cache[connectionPath] = originalConnectionModule;
  else delete require.cache[connectionPath];
  if (originalModelModule) require.cache[modelPath] = originalModelModule;
  else delete require.cache[modelPath];
});
