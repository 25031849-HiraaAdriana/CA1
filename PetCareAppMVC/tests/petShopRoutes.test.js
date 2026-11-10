const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const calls = [];
let catalogScenario = 'normal';
let trackedCartCount = 0;
let cartCountFailure = false;
const documentStorageDirectory = path.join(os.tmpdir(), `pethub-shop-route-${randomUUID()}`);
const previousDocumentStorageDirectory = process.env.PET_SHOP_DOCUMENT_STORAGE_DIR;
process.env.PET_SHOP_DOCUMENT_STORAGE_DIR = documentStorageDirectory;
let savedDocument;
const product = {
  id: 12,
  product_name: 'Sample food',
  brand: 'Local supplier',
  description: 'A mock product used only in an isolated route test.',
  price_sgd: '1.15',
  stock_quantity: 5,
  species_suitability: ['Cat'],
  category_code: 'animal-food-beverages',
  category_name: 'Animal Food & Beverages',
  image_path: null
};
const categories = [
  {
    id: 1,
    category_code: 'animal-medical-healthcare',
    category_name: 'Animal Medical & Healthcare',
    description: 'Everyday non-prescription care essentials.',
    product_count: 0,
    is_active: 1
  },
  {
    id: 2,
    category_code: 'animal-food-beverages',
    category_name: 'Animal Food & Beverages',
    description: 'Food and hydration products.',
    product_count: 1,
    is_active: 1
  },
  {
    id: 3,
    category_code: 'animal-grooming-care',
    category_name: 'Animal Grooming & Care',
    description: 'Grooming and daily-care essentials.',
    product_count: 0,
    is_active: 1
  },
  {
    id: 4,
    category_code: 'animal-accessories',
    category_name: 'Animal Accessories',
    description: 'Comfort and everyday accessories.',
    product_count: 0,
    is_active: 1
  }
];
const trustedBrands = [
  ['purina', 'Purina', 'cats_dogs'],
  ['whiskas', 'Whiskas', 'cats_dogs'],
  ['royal-canin', 'Royal Canin', 'cats_dogs'],
  ['sheba', 'Sheba', 'cats_dogs'],
  ['applaws', 'Applaws', 'cats_dogs'],
  ['cesar', 'Cesar', 'cats_dogs'],
  ['nature', 'Nature', 'small_furries'],
  ['vita-prima', 'Vita Prima', 'small_furries'],
  ['bunny-nature', 'Bunny Nature', 'small_furries'],
  ['science-selective', 'Science Selective', 'small_furries']
].map(([brand_code, brand_name, storefront_group], index) => ({
  id: index + 1,
  brand_code,
  brand_name,
  normalized_name: brand_name.toLowerCase().replace(/[^a-z0-9]/g, ''),
  storefront_group,
  display_order: index + 1
}));
const royalCaninProduct = {
  ...product,
  id: 13,
  product_name: 'Royal Canin Kitten Food',
  brand: 'Royal Canin',
  trusted_brand_id: 3,
  storefront_placement: 'trusted_cats_dogs'
};
const petShopModel = {
  isFeatureReady: async () => {
    if (catalogScenario === 'connection-error') {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:3306');
      error.code = 'ECONNREFUSED';
      throw error;
    }
    return catalogScenario !== 'migration-missing';
  },
  getCategories: async () => categories,
  getTrustedBrands: async () => trustedBrands,
  getTrustedBrandByCode: async code => trustedBrands.find(brand => brand.brand_code === code) || null,
  getTrustedBrandByNormalizedName: async name => trustedBrands.find(brand => brand.normalized_name === name) || null,
  getBrandSuggestions: async () => trustedBrands.map(brand => brand.brand_name),
  getStorefrontSpecies: async filters => filters.brandId === 3 ? ['Cat'] : ['Cat'],
  getSpeciesOptions: async () => ['Cat', 'Dog', 'Guinea Pig', 'Hamster', 'Rabbit'],
  listProducts: async filters => {
    calls.push({ type: 'listProducts', filters });
    if (catalogScenario === 'database-error') {
      const error = new Error('Unknown column minimum_age_months in field list');
      error.code = 'ER_BAD_FIELD_ERROR';
      throw error;
    }
    if (catalogScenario === 'empty') return [];
    if (filters.brandId) {
      return filters.brandId === 3 &&
        (!filters.search || royalCaninProduct.product_name.toLowerCase().includes(filters.search.toLowerCase())) &&
        (!filters.species || filters.species === 'Cat') &&
        (!filters.priceRange || filters.priceRange === 'below-20') &&
        (!filters.ageCategory || filters.ageCategory === 'age-limited')
        ? [royalCaninProduct]
        : [];
    }
    if (filters.storefrontPlacement && filters.storefrontPlacement !== 'pethub_products') return [];
    if (filters.category && filters.category !== product.category_code) return [];
    return [product];
  },
  getProduct: async id => id === product.id ? product : id === royalCaninProduct.id ? royalCaninProduct : null,
  recordRecentlyViewed: async (userId, productId) => calls.push({ type: 'recordRecentlyViewed', userId, productId }),
  setFavourite: async (userId, productId, shouldFavourite) => calls.push({
    type: 'setFavourite', userId, productId, shouldFavourite
  }),
  getCartCount: async userId => {
    calls.push({ type: 'getCartCount', userId });
    if (cartCountFailure) {
      const error = new Error('test cart count failure');
      error.code = 'TEST_CART_COUNT';
      throw error;
    }
    if (userId === 99) return trackedCartCount;
    return 2;
  },
  getOwnerPets: async () => [{ id: 4, name: 'Luna', species: 'Cat', age: 4 }],
  getOwnerPet: async (ownerId, petId) => {
    calls.push({ type: 'getOwnerPet', ownerId, petId });
    return ownerId === 7 && petId === 4
      ? { id: 4, name: 'Luna', species: 'Cat', age: 4 }
      : null;
  },
  getCart: async userId => {
    calls.push({ type: 'getCart', userId });
    if (userId === 99 && trackedCartCount === 0) return [];
    return [{
      cart_item_id: 3,
      product_id: 12,
      product_name: 'Sample food',
      brand: 'Local supplier',
      quantity: userId === 99 ? trackedCartCount : 2,
      price_sgd: '1.15',
      stock_quantity: 5,
      availabilityError: null
    }];
  },
  addToCart: async (userId, productId, quantity) => {
    calls.push({ type: 'addToCart', userId, productId, quantity });
    if (userId === 99) trackedCartCount += quantity;
  },
  updateCartItem: async (userId, itemId, quantity) => {
    calls.push({ type: 'updateCartItem', userId, itemId, quantity });
    if (userId === 99) trackedCartCount = quantity;
    return true;
  },
  removeCartItem: async (userId, itemId) => {
    calls.push({ type: 'removeCartItem', userId, itemId });
    if (userId === 99) trackedCartCount = 0;
    return true;
  },
  getAdminCategories: async () => categories,
  getProductAgeMonthStep: async () => 1,
  getFavouriteProductIds: async () => new Set(),
  getFavouriteProducts: async () => [],
  getRecentlyViewedProducts: async () => [],
  clearRecentlyViewed: async userId => calls.push({ type: 'clearRecentlyViewed', userId }),
  saveProduct: async () => {
    calls.push({ type: 'saveProduct' });
    return 20;
  },
  getProductsForAdmin: async () => [
    {
      ...product,
      image_path: '/uploads/pet-shop/sample-food.jpg',
      storefront_placement: 'pethub_products',
      internal_review_status: 'approved_for_internal_listing',
      safety_review_status: 'cleared',
      expiry_date: null
    },
    {
      ...product,
      id: 14,
      product_name: 'Unbranded item',
      brand: null,
      image_path: null,
      storefront_placement: 'not_listed',
      internal_review_status: 'pending_review',
      safety_review_status: 'pending',
      expiry_date: null
    }
  ],
  getProductForAdmin: async () => null,
  getProductDocument: async (productId, documentId) => (
    productId === 20 && documentId === 55 && savedDocument
      ? {
          storage_key: savedDocument.storageKey,
          original_filename: savedDocument.filename,
          mime_type: savedDocument.mimeType,
          size_bytes: savedDocument.sizeBytes
        }
      : null
  )
};
petShopModel.saveProduct = async (data, adminId, imageFiles, documentFiles) => {
  calls.push({ type: 'saveProduct', data, adminId, imageFiles, documentFiles });
  savedDocument = documentFiles[0];
  return 20;
};
const modelPath = require.resolve('../models/petShopModel');
const originalModelModule = require.cache[modelPath];
const connectionPath = require.resolve('../config/db');
const originalConnectionModule = require.cache[connectionPath];
const isolatedConnection = {
  query() { throw new Error('Unexpected database query in Pet Shop route test.'); },
  promise() {
    return {
      query() { throw new Error('Unexpected database query in Pet Shop route test.'); }
    };
  },
  createPetShopTransactionConnection() {
    throw new Error('Unexpected database transaction in Pet Shop route test.');
  }
};
require.cache[connectionPath] = {
  id: connectionPath,
  filename: connectionPath,
  loaded: true,
  exports: isolatedConnection,
  children: [],
  paths: []
};
const activityModelPath = require.resolve('../models/adminActivityModel');
const originalActivityModelModule = require.cache[activityModelPath];
require.cache[activityModelPath] = {
  id: activityModelPath,
  filename: activityModelPath,
  loaded: true,
  exports: { logAdminAction: async () => true },
  children: [],
  paths: []
};
require.cache[modelPath] = {
  id: modelPath,
  filename: modelPath,
  loaded: true,
  exports: petShopModel,
  children: [],
  paths: []
};
const userModelPath = require.resolve('../models/userModel');
const originalUserModelModule = require.cache[userModelPath];
require.cache[userModelPath] = {
  id: userModelPath,
  filename: userModelPath,
  loaded: true,
  exports: {
    findByCredentials(username, passwordHash, callback) {
      callback(null, [{
        id: 7,
        username,
        name: 'Test account',
        role: 'user'
      }]);
    }
  },
  children: [],
  paths: []
};

let server;
let baseUrl;

async function login(role, id = 7) {
  const response = await fetch(`${baseUrl}/test-login/${role}/${id}`, {
    headers: { Connection: 'close' }
  });
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';', 1)[0];
}

function csrfToken(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'page should include a session CSRF token');
  return match[1];
}

before(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(session({
    secret: 'isolated-pet-shop-route-tests',
    resave: false,
    saveUninitialized: false
  }));
  app.use(flash());
  app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    next();
  });
  app.use(require('../middleware/cartCount'));
  app.get('/test-login/:role/:id', (req, res) => {
    req.session.user = {
      id: Number(req.params.id),
      username: `${req.params.role}-test`,
      name: 'Test account',
      role: req.params.role
    };    res.sendStatus(204);
  });
  app.get('/test-navigation/:page', (req, res) => {
    res.render('partials/navbar', { session: req.session });
  });
  app.use(require('../routes/petShopRoutes'));
  app.use(require('../routes/authRoutes'));
  app.use(require('../routes/adminRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.close();
    server.closeAllConnections();
    server.unref();
  }
  if (originalModelModule) require.cache[modelPath] = originalModelModule;
  else delete require.cache[modelPath];
  if (originalActivityModelModule) require.cache[activityModelPath] = originalActivityModelModule;
  else delete require.cache[activityModelPath];
  if (originalUserModelModule) require.cache[userModelPath] = originalUserModelModule;
  else delete require.cache[userModelPath];
  if (previousDocumentStorageDirectory === undefined) delete process.env.PET_SHOP_DOCUMENT_STORAGE_DIR;
  else process.env.PET_SHOP_DOCUMENT_STORAGE_DIR = previousDocumentStorageDirectory;
  await fs.rm(documentStorageDirectory, { recursive: true, force: true });
  if (originalConnectionModule) require.cache[connectionPath] = originalConnectionModule;
  else delete require.cache[connectionPath];
});

test('unauthenticated shop routes redirect to login and a User returns to the requested collection', async () => {
  for (const route of [
    '/shop',
    '/shop/collections/animal-food-beverages',
    '/shop/products/12',
    '/cart'
  ]) {
    const response = await fetch(`${baseUrl}${route}`, {
      redirect: 'manual',
      headers: { Connection: 'close' }
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  }

  const intendedUrl = '/shop/collections/animal-food-beverages?search=food';
  const protectedResponse = await fetch(`${baseUrl}${intendedUrl}`, {
    redirect: 'manual',
    headers: { Connection: 'close' }
  });
  const sessionCookie = protectedResponse.headers.get('set-cookie').split(';', 1)[0];
  const loginPageResponse = await fetch(`${baseUrl}/login`, {
    headers: { Cookie: sessionCookie, Connection: 'close' }
  });
  const loginPage = await loginPageResponse.text();
  const csrfToken = loginPage.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrfToken);
  const loginResponse = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: sessionCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      Connection: 'close'
    },
    body: new URLSearchParams({ username: 'test-user', password: 'test-password', _csrf: csrfToken })
  });
  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.get('location'), intendedUrl);
  const loggedInCookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];
  const collectionResponse = await fetch(`${baseUrl}${intendedUrl}`, {
    headers: { Cookie: loggedInCookie, Connection: 'close' }
  });
  assert.equal(collectionResponse.status, 200);
});

test('login and signup navigation omit Pet Shop while retaining account links', async () => {
  for (const route of ['/login', '/signup']) {
    const response = await fetch(`${baseUrl}${route}`, { headers: { Connection: 'close' } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(html, /href="\/shop"[^>]*>Pet Shop<\/a>/);
    assert.match(html, /href="\/login"/);
    assert.match(html, /href="\/signup"/);
  }
});

test('shop search and pet suggestions use server filters and owner-scoped pet selection', async () => {
  const userCookie = await login('user');
  const response = await fetch(
    `${baseUrl}/shop?search=food&category=animal-food-beverages&pet_id=4`,
    { headers: { Cookie: userCookie, Connection: 'close' } }
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Thoughtful finds for pets and their people/);
  assert.match(html, /Sample food/);
  assert.match(html, /<h2 id="pomi-products-title">Pomi Products<\/h2>/);
  assert.doesNotMatch(html, /Brand listings are for editorial browsing only/);
  assert.doesNotMatch(html, /A few thoughtful favourites|Featured for everyday care|Explore each collection/i);
  assert.doesNotMatch(html, /Clear filters/);
  assert.match(html, /name="search"/);
  assert.match(html, /name="age_category"/);
  assert.match(html, /name="species"/);
  assert.match(html, /name="price_range"/);
  assert.doesNotMatch(html, /name="category"/);
  assert.match(html, /Cart/);
  assert.match(html, /href="\/css\/pet-shop\.css"/);
  assert.equal(calls.find(call => call.type === 'getOwnerPet').ownerId, 7);
  assert.deepEqual(calls.filter(call => call.type === 'listProducts').at(-1).filters, {
    search: 'food',
    category: 'animal-food-beverages',
    species: 'Cat',
    petAgeMonths: 48,
    maxPrice: null,
    priceRange: '',
    ageCategory: '',
    availableOnly: false,
    storefrontPlacement: 'pethub_products',
    brandId: null,
    userId: 7
  });
  const stylesheet = await fetch(`${baseUrl}/css/pet-shop.css`, {
    headers: { Connection: 'close' }
  });
  assert.equal(stylesheet.status, 200);
  assert.match(await stylesheet.text(), /\.shop-hero/);
});

test('empty catalogue renders an honest empty state and trusted-brand storefront links', async () => {
  catalogScenario = 'empty';
  const userCookie = await login('user');
  const response = await fetch(`${baseUrl}/shop`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Pomi Products/);
  assert.match(html, /No eligible Pomi Products are currently listed/);
  for (const brand of trustedBrands) {
    assert.match(html, new RegExp(`href="/shop/brands/${brand.brand_code}"`));
  }
  assert.doesNotMatch(html, /Shop by collection|name="category"/);
  assert.doesNotMatch(html, /Unable to load the Pet Shop right now/);
  catalogScenario = 'normal';
});

test('all ten trusted brands link to scoped product pages with combined server filters', async () => {
  const userCookie = await login('user');
  const shopResponse = await fetch(`${baseUrl}/shop`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  const shopHtml = await shopResponse.text();
  for (const brand of trustedBrands) {
    assert.match(shopHtml, new RegExp(`href="/shop/brands/${brand.brand_code}"`));
    const response = await fetch(`${baseUrl}/shop/brands/${brand.brand_code}`, {
      headers: { Cookie: userCookie, Connection: 'close' }
    });
    assert.equal(response.status, 200, `${brand.brand_name} page`);
    assert.ok((await response.text()).includes(brand.brand_name));
  }
  assert.equal((shopHtml.match(/class="shop-brand-logo-link"/g) || []).length, 10);
  assert.equal((shopHtml.match(/class="shop-store-logo-link"/g) || []).length, 3);
  assert.doesNotMatch(shopHtml, /src="\/images\/(?:brands|pet-shops)\//);
  assert.equal((shopHtml.match(/data-logo-fallback/g) || []).length, 13);
  assert.match(shopHtml, /aria-label="Royal Canin products"/);
  assert.match(shopHtml, /Cats &amp; Dogs Trusted Brands/);
  assert.match(shopHtml, /Small Furries Trusted Brands/);
  assert.doesNotMatch(shopHtml, /editorial browsing only/);
  for (const website of [
    'https://catsmart.com.sg/',
    'https://www.petloverscentre.com/',
    'https://polypet.com.sg/'
  ]) {
    assert.ok(shopHtml.includes(`href="${website}" target="_blank" rel="noopener noreferrer"`));
  }

  const brandResponse = await fetch(
    `${baseUrl}/shop/brands/royal-canin?search=kitten&age_category=age-limited&species=Cat&price_range=below-20`,
    { headers: { Cookie: userCookie, Connection: 'close' } }
  );
  const brandHtml = await brandResponse.text();
  assert.equal(brandResponse.status, 200);
  assert.match(brandHtml, /Royal Canin Kitten Food/);
  assert.doesNotMatch(brandHtml, /Sample food/);
  assert.match(brandHtml, /name="search" value="kitten"/);
  const brandFilters = calls.filter(call => call.type === 'listProducts').at(-1).filters;
  assert.equal(brandFilters.brandId, 3);
  assert.equal(brandFilters.storefrontPlacement, 'trusted_cats_dogs');
  assert.equal(brandFilters.search, 'kitten');
  assert.equal(brandFilters.ageCategory, 'age-limited');
  assert.equal(brandFilters.species, 'Cat');
  assert.equal(brandFilters.priceRange, 'below-20');

  const unknownBrand = await fetch(`${baseUrl}/shop/brands/not-a-brand`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  assert.equal(unknownBrand.status, 404);
});

test('favourites and product-view history are authenticated, CSRF protected and user scoped', async () => {
  const userCookie = await login('user');
  const shopResponse = await fetch(`${baseUrl}/shop`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  const token = csrfToken(await shopResponse.text());
  const rejected = await fetch(`${baseUrl}/shop/favourites/12`, {
    method: 'POST',
    headers: { Cookie: userCookie, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: 'action=add'
  });
  assert.equal(rejected.status, 403);

  const favourite = await fetch(`${baseUrl}/shop/favourites/12`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: userCookie, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: new URLSearchParams({ _csrf: token, action: 'add', return_to: '/shop' })
  });
  assert.equal(favourite.status, 302);
  assert.equal(favourite.headers.get('location'), '/shop');
  assert.deepEqual(calls.find(call => call.type === 'setFavourite'), {
    type: 'setFavourite',
    userId: 7,
    productId: 12,
    shouldFavourite: true
  });

  const removeFavourite = await fetch(`${baseUrl}/shop/favourites/12`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: userCookie, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: new URLSearchParams({ _csrf: token, action: 'remove', return_to: '/dashboard' })
  });
  assert.equal(removeFavourite.status, 302);
  assert.equal(removeFavourite.headers.get('location'), '/dashboard');
  assert.deepEqual(calls.filter(call => call.type === 'setFavourite').at(-1), {
    type: 'setFavourite',
    userId: 7,
    productId: 12,
    shouldFavourite: false
  });

  const detail = await fetch(`${baseUrl}/shop/products/12`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  assert.equal(detail.status, 200);
  assert.ok(calls.some(call =>
    call.type === 'recordRecentlyViewed' && call.userId === 7 && call.productId === 12
  ));

  const clearHistory = await fetch(`${baseUrl}/dashboard/recently-viewed/clear`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: userCookie, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: new URLSearchParams({ _csrf: token })
  });
  assert.equal(clearHistory.status, 302);
  assert.equal(clearHistory.headers.get('location'), '/dashboard');
  assert.ok(calls.some(call => call.type === 'clearRecentlyViewed' && call.userId === 7));

  const adminCookie = await login('admin');
  const forbidden = await fetch(`${baseUrl}/shop/favourites/12`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: new URLSearchParams({ _csrf: token, action: 'add' })
  });
  assert.equal(forbidden.status, 302);
  assert.equal(forbidden.headers.get('location'), '/admin/dashboard');
});

test('legacy category pages remain accessible while the Shop homepage omits category collections', async () => {
  const userCookie = await login('user');
  const shopResponse = await fetch(`${baseUrl}/shop`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  const shopHtml = await shopResponse.text();
  assert.equal(shopResponse.status, 200);
  assert.doesNotMatch(shopHtml, /shop-category-button|shop-collection-grid|name="category"/);
  const searchForm = shopHtml.match(/<form class="shop-filters shop-storefront-filters"[\s\S]*?<\/form>/);
  assert.ok(searchForm);
  assert.match(searchForm[0], /name="search"/);
  assert.match(searchForm[0], /name="age_category"/);
  assert.match(searchForm[0], /name="species"/);
  assert.match(searchForm[0], /name="price_range"/);

  const routeCodes = categories.map(category => category.category_code);
  for (const categoryCode of routeCodes) {
    const categoryPath = `/shop/collections/${categoryCode}`;
    const response = await fetch(`${baseUrl}${categoryPath}`, {
      headers: { Cookie: userCookie, Connection: 'close' }
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    const categoryName = categories.find(category => category.category_code === categoryCode).category_name;
    assert.ok(html.includes(categoryName.replace('&', '&amp;')));
    assert.match(html, /Pet Shop<\/a><span aria-hidden="true">\/<\/span>/);
    assert.doesNotMatch(html, /Thoughtful finds for pets and their people/);
    const switcher = html.match(/<nav class="shop-collection-switcher"[\s\S]*?<\/nav>/);
    assert.ok(switcher);
    for (const otherCategoryCode of routeCodes) {
      assert.ok(switcher[0].includes(`/shop/collections/${otherCategoryCode}`));
    }
    const query = calls.filter(call => call.type === 'listProducts').at(-1);
    assert.equal(query.filters.category, categoryCode);
    if (categoryCode === 'animal-food-beverages') {
      assert.match(html, /Sample food/);
      assert.match(html, /\/shop\/products\/12/);
      const productResponse = await fetch(`${baseUrl}/shop/products/12`, {
        headers: { Cookie: userCookie, Connection: 'close' }
      });
      assert.equal(productResponse.status, 200);
      assert.match(await productResponse.text(), /Sample food/);
    } else {
      assert.match(html, /No eligible products are listed here yet/);
      assert.doesNotMatch(html, /Sample food/);
    }
  }
});

test('missing migration tables show the boutique migration-ready state', async () => {
  catalogScenario = 'migration-missing';
  const userCookie = await login('user');
  const response = await fetch(`${baseUrl}/shop`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  const html = await response.text();
  assert.equal(response.status, 503);
  assert.match(html, /The shop is getting ready/);
  assert.match(html, /pet-shop\.css/);
  catalogScenario = 'normal';
});

test('catalogue database errors are logged server-side and render a safe storefront message', async () => {
  catalogScenario = 'database-error';
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const userCookie = await login('user');
    const response = await fetch(`${baseUrl}/shop`, {
      headers: { Cookie: userCookie, Connection: 'close' }
    });
    const html = await response.text();
    assert.equal(response.status, 503);
    assert.match(html, /collection is temporarily unavailable/i);
    assert.doesNotMatch(html, /ER_BAD_FIELD_ERROR|minimum_age_months|SQLSTATE|password/i);
    assert.ok(errors.some(args => args.some(value =>
      value && typeof value === 'object' && value.code === 'ER_BAD_FIELD_ERROR'
    )));
  } finally {
    console.error = originalConsoleError;
    catalogScenario = 'normal';
  }
});

test('database connection failures do not expose connection details to users', async () => {
  catalogScenario = 'connection-error';
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const userCookie = await login('user');
    const response = await fetch(`${baseUrl}/shop`, {
      headers: { Cookie: userCookie, Connection: 'close' }
    });
    const html = await response.text();
    assert.equal(response.status, 503);
    assert.match(html, /collection is temporarily unavailable/i);
    assert.doesNotMatch(html, /ECONNREFUSED|127\.0\.0\.1|3306/);
    assert.ok(errors.some(args => args.some(value =>
      value && typeof value === 'object' && value.code === 'ECONNREFUSED'
    )));
  } finally {
    console.error = originalConsoleError;
    catalogScenario = 'normal';
  }
});

test('cart access, CSRF, quantity validation and money totals are enforced', async () => {
  const userCookie = await login('user');
  const catalogResponse = await fetch(`${baseUrl}/shop`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  const catalog = await catalogResponse.text();
  const token = csrfToken(catalog);

  const missingToken = await fetch(`${baseUrl}/cart/items/12`, {
    method: 'POST',
    headers: { Cookie: userCookie, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: 'quantity=2'
  });
  assert.equal(missingToken.status, 403);

  const invalidQuantity = await fetch(`${baseUrl}/cart/items/12`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: userCookie, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: new URLSearchParams({ _csrf: token, quantity: '0' })
  });
  assert.equal(invalidQuantity.status, 302);
  assert.equal(calls.some(call => call.type === 'addToCart'), false);

  const addResponse = await fetch(`${baseUrl}/cart/items/12`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: userCookie, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: new URLSearchParams({ _csrf: token, quantity: '2' })
  });
  assert.equal(addResponse.status, 302);
  assert.deepEqual(calls.find(call => call.type === 'addToCart'), {
    type: 'addToCart',
    userId: 7,
    productId: 12,
    quantity: 2
  });

  const cartResponse = await fetch(`${baseUrl}/cart`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  const cartHtml = await cartResponse.text();
  assert.equal(cartResponse.status, 200);
  assert.match(cartHtml, /SGD 2\.30/);
  assert.doesNotMatch(cartHtml, /<button[^>]*>\s*(?:Checkout|Pay now|Payment card)/i);
});

test('cart badge follows the owner across pages and reflects cart changes', async () => {
  trackedCartCount = 0;
  const owner = await login('user', 99);
  const other = await login('user', 100);
  const get = async (route, cookie) => (await fetch(`${baseUrl}${route}`, {
    headers: { Cookie: cookie, Connection: 'close' }
  })).text();
  const shop = await get('/shop', owner);
  const token = csrfToken(shop);
  const post = (route, fields) => fetch(`${baseUrl}${route}`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: owner, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: new URLSearchParams({ _csrf: token, ...fields })
  });
  const badge = count => new RegExp(`class="shop-cart-count" aria-hidden="true">${count}<`);
  assert.doesNotMatch(shop, /class="shop-cart-count"/);
  assert.equal((await post('/cart/items/12', { quantity: '2' })).status, 302);
  for (const route of ['/shop', '/shop/products/12', '/cart', '/test-navigation/dashboard', '/test-navigation/vets']) {
    assert.match(await get(route, owner), badge(2), route);
  }
  assert.match(await get('/test-navigation/dashboard', other), badge(2));
  assert.equal((await post('/cart/items/3/quantity', { quantity: '3' })).status, 302);
  assert.match(await get('/test-navigation/dashboard', owner), badge(3));
  assert.match(await get('/test-navigation/dashboard', other), badge(2));
  assert.equal((await post('/cart/items/3/remove', {})).status, 302);
  assert.doesNotMatch(await get('/test-navigation/vets', owner), /class="shop-cart-count"/);
});

test('cart count failures are logged and surfaced without inventing a zero count', async () => {
  const owner = await login('user', 99);
  const errors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => errors.push(args);
  cartCountFailure = true;
  try {
    const response = await fetch(`${baseUrl}/test-navigation/dashboard`, {
      headers: { Cookie: owner, Connection: 'close' }
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Shopping Cart \(item count unavailable\)/);
    assert.doesNotMatch(html, /class="shop-cart-count"/);
    assert.ok(errors.some(args => args.includes('TEST_CART_COUNT')));
  } finally {
    cartCountFailure = false;
    console.error = originalConsoleError;
  }
});

test('cart count middleware skips guests, admins and non-GET requests', async () => {
  const middleware = require('../middleware/cartCount');
  for (const [method, user] of [['GET', null], ['GET', { id: 1, role: 'admin' }], ['POST', { id: 99, role: 'user' }]]) {
    const previousCalls = calls.length;
    let nextCalled = false;
    await middleware({ method, session: { user } }, { locals: {} }, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(calls.length, previousCalls);
  }
});

test('Admin product management remains Admin-only, CSRF-protected and excludes prescription listings', async () => {
  const userCookie = await login('user');
  const forbidden = await fetch(`${baseUrl}/admin/products`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  assert.equal(forbidden.status, 403);

  const adminCookie = await login('admin');
  const managementResponse = await fetch(`${baseUrl}/admin/products`, {
    headers: { Cookie: adminCookie, Connection: 'close' }
  });
  const managementHtml = await managementResponse.text();
  assert.equal(managementResponse.status, 200);
  assert.doesNotMatch(managementHtml, /Manage categories/i);
  assert.doesNotMatch(managementHtml, /<table\b/);
  assert.match(managementHtml, /class="shop-admin-products-grid"/);
  assert.match(managementHtml, /src="\/uploads\/pet-shop\/sample-food\.jpg"/);
  assert.match(managementHtml, /No product image/);
  assert.match(managementHtml, /No brand/);
  assert.match(managementHtml, /SGD 1\.15/);
  assert.match(managementHtml, /Pomi Products/);
  assert.match(managementHtml, /href="\/admin\/products\/12\/edit"/);
  assert.match(managementHtml, /Create product/);
  const formResponse = await fetch(`${baseUrl}/admin/products/new`, {
    headers: { Cookie: adminCookie, Connection: 'close' }
  });
  const formHtml = await formResponse.text();
  assert.equal(formResponse.status, 200);
  assert.match(formHtml, /Supplier and submitted references/);
  assert.match(formHtml, /name="supplier_name"/);
  assert.match(formHtml, /name="country_of_origin"/);
  assert.match(formHtml, /name="submitted_licence_number"/);
  assert.match(formHtml, /data-category-code="animal-medical-healthcare"/);
  assert.match(formHtml, /data-prescription-control hidden/);
  assert.match(formHtml, /Products requiring a veterinary prescription cannot be listed for sale in the CA1 Pet Shop\./);
  assert.match(formHtml, /name="storefront_placement"/);
  assert.match(formHtml, /name="age_suitability"/);
  assert.match(formHtml, /type="checkbox" name="species_suitability" value="Rabbit"/);
  assert.match(formHtml, /type="checkbox" name="species_suitability" value="Guinea Pig"/);
  assert.match(formHtml, /list="knownProductBrands"/);
  const token = csrfToken(formHtml);

  const response = await fetch(`${baseUrl}/admin/products`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
    body: new URLSearchParams({
      _csrf: token,
      category_id: '1',
      storefront_placement: 'pethub_products',
      product_name: 'Mock prescription item',
      description: 'This listing must not enter the CA1 shop.',
      price_sgd: '5.00',
      stock_quantity: '4',
      species_suitability: 'Cat',
      minimum_age_months: '2',
      maximum_age_months: '6',
      expiry_date: '',
      internal_review_status: 'pending_review',
      safety_review_status: 'pending',
      is_prescription_product: '1'
    })
  });
  assert.equal(response.status, 400);
  assert.equal(calls.some(call => call.type === 'saveProduct'), false);

  const preservedFlagResponse = await fetch(`${baseUrl}/admin/products`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      Connection: 'close'
    },
    body: new URLSearchParams({
      _csrf: token,
      category_id: '2',
      storefront_placement: 'pethub_products',
      product_name: 'Existing flagged item',
      description: 'The hidden existing flag must not be cleared.',
      price_sgd: '5.00',
      stock_quantity: '4',
      species_suitability: 'Cat',
      internal_review_status: 'pending_review',
      safety_review_status: 'pending',
      prescription_flag_fallback: '1'
    })
  });
  assert.equal(preservedFlagResponse.status, 400);
  assert.equal(calls.some(call => call.type === 'saveProduct'), false);

  const trustedBrandBody = new URLSearchParams({
    _csrf: token,
    category_id: '2',
    storefront_placement: 'trusted_cats_dogs',
    product_name: 'Trusted brand item',
    brand: 'RoyalCanin',
    description: 'A mock product for controlled brand mapping.',
    price_sgd: '5.00',
    stock_quantity: '4',
    internal_review_status: 'pending_review',
    safety_review_status: 'pending'
  });
  ['Rabbit', 'Guinea Pig', 'Hamster'].forEach(species => {
    trustedBrandBody.append('species_suitability', species);
  });
  const trustedBrandResponse = await fetch(`${baseUrl}/admin/products`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      Connection: 'close'
    },
    body: trustedBrandBody
  });
  assert.equal(trustedBrandResponse.status, 302);
  const savedTrustedBrand = calls.filter(call => call.type === 'saveProduct').at(-1).data;
  assert.equal(savedTrustedBrand.brand, 'Royal Canin');
  assert.equal(savedTrustedBrand.trustedBrandId, 3);
  assert.equal(savedTrustedBrand.storefrontPlacement, 'trusted_cats_dogs');
  assert.deepEqual(savedTrustedBrand.speciesSuitability, ['Rabbit', 'Guinea Pig', 'Hamster']);

  const arbitraryBrandResponse = await fetch(`${baseUrl}/admin/products`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      Connection: 'close'
    },
    body: new URLSearchParams({
      _csrf: token,
      category_id: '2',
      storefront_placement: 'trusted_cats_dogs',
      product_name: 'Unknown brand item',
      brand: 'Unaffiliated brand',
      description: 'An unknown brand cannot enter a trusted page.',
      price_sgd: '5.00',
      stock_quantity: '4',
      species_suitability: 'Cat',
      internal_review_status: 'pending_review',
      safety_review_status: 'pending'
    })
  });
  assert.equal(arbitraryBrandResponse.status, 400);
});

test('unused Admin product collections page and update endpoint are removed', async () => {
  const adminCookie = await login('admin');
  const pageResponse = await fetch(`${baseUrl}/admin/products/categories`, {
    headers: { Cookie: adminCookie, Connection: 'close' }
  });
  assert.equal(pageResponse.status, 404);

  const updateResponse = await fetch(`${baseUrl}/admin/products/categories/1`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      Connection: 'close'
    },
    body: new URLSearchParams({ description: 'Unused collection' })
  });
  assert.equal(updateResponse.status, 404);
});

test('Admin supplier PDFs stay private and are downloadable only through the Admin route', async () => {
  calls.length = 0;
  savedDocument = undefined;
  const adminCookie = await login('admin');
  const formResponse = await fetch(`${baseUrl}/admin/products/new`, {
    headers: { Cookie: adminCookie, Connection: 'close' }
  });
  const formHtml = await formResponse.text();
  const token = csrfToken(formHtml);
  const missingTokenForm = new FormData();
  missingTokenForm.append('product_name', 'Must not be saved');
  missingTokenForm.append(
    'supporting_documents',
    new Blob(['%PDF-1.7\nprivate test document'], { type: 'application/pdf' }),
    'document.pdf'
  );
  const missingTokenResponse = await fetch(`${baseUrl}/admin/products`, {
    method: 'POST',
    headers: { Cookie: adminCookie, Connection: 'close' },
    body: missingTokenForm
  });
  assert.equal(missingTokenResponse.status, 403);
  assert.equal(calls.some(call => call.type === 'saveProduct'), false);

  const form = new FormData();
  for (const [name, value] of Object.entries({
    _csrf: token,
    category_id: '1',
    storefront_placement: 'pethub_products',
    product_name: 'Sample non-prescription product',
    description: 'A mock product for a route test.',
    price_sgd: '3.25',
    stock_quantity: '4',
    species_suitability: 'Cat',
    minimum_age_months: '2',
    maximum_age_months: '6',
    expiry_date: '',
    internal_review_status: 'pending_review',
    safety_review_status: 'pending',
    is_active: '0'
  })) form.append(name, value);
  form.append(
    'supporting_documents',
    new Blob(['%PDF-1.7\nprivate test document'], { type: 'application/pdf' }),
    '..\\supplier\\document.pdf'
  );

  const saveResponse = await fetch(`${baseUrl}/admin/products`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie, Connection: 'close' },
    body: form
  });
  assert.equal(saveResponse.status, 302, await saveResponse.text());
  const savedProduct = calls.find(call => call.type === 'saveProduct');
  assert.equal(savedProduct.data.minimumAgeMonths, 2);
  assert.equal(savedProduct.data.maximumAgeMonths, 6);
  assert.equal(savedProduct.data.supplierName, null);
  assert.ok(savedDocument.storageKey);
  assert.equal((await fs.stat(path.join(documentStorageDirectory, savedDocument.storageKey))).isFile(), true);
  const publicDirectory = path.resolve(__dirname, '..', 'public');
  const relativeStoragePath = path.relative(publicDirectory, documentStorageDirectory);
  assert.ok(
    relativeStoragePath === '..' ||
    relativeStoragePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeStoragePath)
  );

  const userCookie = await login('user');
  const forbidden = await fetch(`${baseUrl}/admin/products/20/documents/55`, {
    headers: { Cookie: userCookie, Connection: 'close' }
  });
  assert.equal(forbidden.status, 403);

  const download = await fetch(`${baseUrl}/admin/products/20/documents/55`, {
    headers: { Cookie: adminCookie, Connection: 'close' }
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  assert.match(download.headers.get('content-disposition'), /filename="document\.pdf"/);
  assert.equal(await download.text(), '%PDF-1.7\nprivate test document');
});
