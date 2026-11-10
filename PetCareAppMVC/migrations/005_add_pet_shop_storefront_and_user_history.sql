USE petcare;

CREATE TABLE IF NOT EXISTS pet_shop_trusted_brands (
  id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  brand_code VARCHAR(60) NOT NULL,
  brand_name VARCHAR(120) NOT NULL,
  normalized_name VARCHAR(120) NOT NULL,
  storefront_group ENUM('cats_dogs', 'small_furries') NOT NULL,
  display_order SMALLINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_pet_shop_trusted_brands_code (brand_code),
  UNIQUE KEY uq_pet_shop_trusted_brands_normalized_name (normalized_name),
  KEY idx_pet_shop_trusted_brands_group_order (storefront_group, display_order)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO pet_shop_trusted_brands
  (brand_code, brand_name, normalized_name, storefront_group, display_order)
VALUES
  ('purina', 'Purina', 'purina', 'cats_dogs', 1),
  ('whiskas', 'Whiskas', 'whiskas', 'cats_dogs', 2),
  ('royal-canin', 'Royal Canin', 'royalcanin', 'cats_dogs', 3),
  ('sheba', 'Sheba', 'sheba', 'cats_dogs', 4),
  ('applaws', 'Applaws', 'applaws', 'cats_dogs', 5),
  ('cesar', 'Cesar', 'cesar', 'cats_dogs', 6),
  ('nature', 'Nature', 'nature', 'small_furries', 1),
  ('vita-prima', 'Vita Prima', 'vitaprima', 'small_furries', 2),
  ('bunny-nature', 'Bunny Nature', 'bunnynature', 'small_furries', 3),
  ('science-selective', 'Science Selective', 'scienceselective', 'small_furries', 4);

ALTER TABLE pet_shop_products
  ADD COLUMN storefront_placement ENUM(
    'pethub_products',
    'trusted_cats_dogs',
    'trusted_small_furries'
  ) NULL,
  ADD COLUMN trusted_brand_id SMALLINT UNSIGNED NULL,
  ADD KEY idx_pet_shop_products_storefront (storefront_placement, trusted_brand_id),
  ADD CONSTRAINT fk_pet_shop_products_trusted_brand
    FOREIGN KEY (trusted_brand_id) REFERENCES pet_shop_trusted_brands(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE IF NOT EXISTS pet_shop_user_favourites (
  user_id INT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_id),
  KEY idx_pet_shop_user_favourites_product (product_id),
  CONSTRAINT fk_pet_shop_user_favourites_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_pet_shop_user_favourites_product
    FOREIGN KEY (product_id) REFERENCES pet_shop_products(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pet_shop_recently_viewed (
  user_id INT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  viewed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, product_id),
  KEY idx_pet_shop_recently_viewed_user_time (user_id, viewed_at),
  CONSTRAINT fk_pet_shop_recently_viewed_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_pet_shop_recently_viewed_product
    FOREIGN KEY (product_id) REFERENCES pet_shop_products(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
