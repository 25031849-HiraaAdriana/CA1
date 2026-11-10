const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

function readTableDefinitions(sql) {
  const definitions = new Map();
  const pattern = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\)\s*ENGINE=/gi;
  for (const match of sql.matchAll(pattern)) definitions.set(match[1], match[2]);
  return definitions;
}

function columnType(definition, columnName) {
  const match = definition.match(new RegExp(`^\\s*${columnName}\\s+([A-Z]+(?:\\(\\d+(?:,\\d+)?\\))?(?:\\s+UNSIGNED)?)\\b`, 'im'));
  return match && match[1].replace(/\s+/g, ' ').toUpperCase();
}

test('Task 7 migration defines six MySQL 8 tables and exactly four idempotent categories', async () => {
  const migration = await fs.readFile(path.join(root, 'migrations', '004_add_pet_shop.sql'), 'utf8');
  const definitions = readTableDefinitions(migration);
  assert.deepEqual([...definitions.keys()], [
    'pet_shop_categories',
    'pet_shop_products',
    'pet_shop_product_images',
    'pet_shop_product_documents',
    'pet_shop_carts',
    'pet_shop_cart_items'
  ]);
  assert.doesNotMatch(migration, /^\s*\*\s+CREATE TABLE/m);
  assert.match(migration, /ENGINE=InnoDB/);
  assert.match(migration, /species_suitability JSON NOT NULL/);
  assert.match(migration, /minimum_age_months SMALLINT UNSIGNED NULL/);
  assert.match(migration, /maximum_age_months SMALLINT UNSIGNED NULL/);
  assert.match(migration, /CONSTRAINT chk_pet_shop_products_age_range\s+CHECK\s*\(/);
  assert.match(migration, /CONSTRAINT chk_pet_shop_cart_items_quantity CHECK \(quantity > 0\)/);
  assert.match(migration, /INSERT IGNORE INTO pet_shop_categories/);
  assert.equal((migration.match(/^\s+\('animal-/gm) || []).length, 4);
});

test('all Task 7 foreign-key column types match their referenced table definitions', async () => {
  const migration = await fs.readFile(path.join(root, 'migrations', '004_add_pet_shop.sql'), 'utf8');
  const baseSchema = await fs.readFile(path.join(root, 'db.sql'), 'utf8');
  const definitions = readTableDefinitions(migration);
  const usersDefinition = baseSchema.match(/CREATE TABLE users\s*\(([\s\S]*?)\)\s*ENGINE=/i)[1];
  const referencedTables = new Map([
    ['users', usersDefinition],
    ...definitions
  ]);

  for (const [tableName, definition] of definitions) {
    for (const match of definition.matchAll(/FOREIGN KEY\s*\((\w+)\)\s+REFERENCES\s+(\w+)\((\w+)\)/gi)) {
      const [, columnName, referencedTable, referencedColumn] = match;
      assert.ok(referencedTables.has(referencedTable), `${tableName}.${columnName} references a known table`);
      assert.equal(
        columnType(definition, columnName),
        columnType(referencedTables.get(referencedTable), referencedColumn),
        `${tableName}.${columnName} must match ${referencedTable}.${referencedColumn}`
      );
    }
  }
  assert.equal(columnType(usersDefinition, 'id'), 'INT UNSIGNED');
});

test('storefront and user history migration is additive, owner-scoped and leaves existing products unclassified', async () => {
  // This migration was originally executed as 006 and later renamed to 005; only the filename changed.
  const migration = await fs.readFile(
    path.join(root, 'migrations', '005_add_pet_shop_storefront_and_user_history.sql'),
    'utf8'
  );
  const definitions = readTableDefinitions(migration);
  assert.deepEqual([...definitions.keys()], [
    'pet_shop_trusted_brands',
    'pet_shop_user_favourites',
    'pet_shop_recently_viewed'
  ]);
  assert.match(migration, /storefront_placement ENUM\([\s\S]*'pethub_products'[\s\S]*'trusted_cats_dogs'[\s\S]*'trusted_small_furries'\s*\) NULL/);
  assert.match(migration, /trusted_brand_id SMALLINT UNSIGNED NULL/);
  assert.match(migration, /FOREIGN KEY \(trusted_brand_id\) REFERENCES pet_shop_trusted_brands\(id\)/);
  assert.match(migration, /UNIQUE KEY uq_pet_shop_trusted_brands_normalized_name/);
  assert.match(migration, /PRIMARY KEY \(user_id, product_id\)/g);
  assert.match(definitions.get('pet_shop_user_favourites'), /user_id INT UNSIGNED NOT NULL/);
  assert.match(definitions.get('pet_shop_user_favourites'), /product_id BIGINT UNSIGNED NOT NULL/);
  assert.match(definitions.get('pet_shop_recently_viewed'), /user_id INT UNSIGNED NOT NULL/);
  assert.match(definitions.get('pet_shop_recently_viewed'), /product_id BIGINT UNSIGNED NOT NULL/);
  for (const brandName of [
    'Purina', 'Whiskas', 'Royal Canin', 'Sheba', 'Applaws', 'Cesar',
    'Nature', 'Vita Prima', 'Bunny Nature', 'Science Selective'
  ]) {
    assert.ok(migration.includes(`'${brandName}'`));
  }
  assert.doesNotMatch(migration, /UPDATE pet_shop_products|DELETE FROM|DROP TABLE|TRUNCATE|INSERT INTO pet_shop_products/i);
});
