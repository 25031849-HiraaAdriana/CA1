USE petcare;

CREATE TABLE IF NOT EXISTS pet_shop_categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  category_code VARCHAR(60) NOT NULL,
  category_name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NOT NULL,
  image_path VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pet_shop_categories_code (category_code)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO pet_shop_categories (category_code, category_name, description) VALUES
  ('animal-medical-healthcare', 'Animal Medical & Healthcare', 'Everyday, non-prescription care essentials selected for responsible pet care.'),
  ('animal-food-beverages', 'Animal Food & Beverages', 'Food and hydration products with clear ingredients and suitability details.'),
  ('animal-grooming-care', 'Animal Grooming & Care', 'Thoughtful grooming and daily-care essentials for pets.'),
  ('animal-accessories', 'Animal Accessories', 'Useful accessories chosen for comfort and everyday life.');

CREATE TABLE IF NOT EXISTS pet_shop_products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  category_id INT UNSIGNED NOT NULL,
  product_name VARCHAR(180) NOT NULL,
  brand VARCHAR(120) NULL,
  description TEXT NOT NULL,
  intended_purpose VARCHAR(500) NULL,
  price_sgd DECIMAL(10,2) NOT NULL,
  stock_quantity INT UNSIGNED NOT NULL DEFAULT 0,
  is_prescription_product TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  internal_review_status ENUM(
    'pending_review',
    'approved_for_internal_listing',
    'requires_additional_information',
    'rejected',
    'unavailable'
  ) NOT NULL DEFAULT 'pending_review',
  safety_review_status ENUM('pending', 'cleared', 'concern') NOT NULL DEFAULT 'pending',
  ingredients_materials TEXT NULL,
  species_suitability JSON NOT NULL,
  minimum_age_months SMALLINT UNSIGNED NULL,
  maximum_age_months SMALLINT UNSIGNED NULL,
  usage_instructions TEXT NULL,
  safety_warnings TEXT NULL,
  expiry_date DATE NULL,
  supplier_name VARCHAR(180) NULL,
  supplier_reference VARCHAR(500) NULL,
  country_of_origin VARCHAR(120) NULL,
  supporting_document_reference VARCHAR(1000) NULL,
  regulatory_authority_reference VARCHAR(500) NULL,
  submitted_licence_number VARCHAR(180) NULL,
  safety_reviewed_at DATETIME NULL,
  safety_reviewed_by_admin_id INT UNSIGNED NULL,
  created_by_admin_id INT UNSIGNED NOT NULL,
  updated_by_admin_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_pet_shop_products_category_status (category_id, is_active, internal_review_status),
  KEY idx_pet_shop_products_expiry (expiry_date),
  KEY idx_pet_shop_products_listing (is_active, internal_review_status, safety_review_status),
  CONSTRAINT fk_pet_shop_products_category
    FOREIGN KEY (category_id) REFERENCES pet_shop_categories(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_pet_shop_products_safety_reviewer
    FOREIGN KEY (safety_reviewed_by_admin_id) REFERENCES users(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_pet_shop_products_creator
    FOREIGN KEY (created_by_admin_id) REFERENCES users(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_pet_shop_products_updater
    FOREIGN KEY (updated_by_admin_id) REFERENCES users(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_pet_shop_products_price CHECK (price_sgd >= 0),
  CONSTRAINT chk_pet_shop_products_age_range
    CHECK (
      maximum_age_months IS NULL OR
      minimum_age_months IS NULL OR
      maximum_age_months >= minimum_age_months
    )
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pet_shop_product_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  image_path VARCHAR(500) NOT NULL,
  alt_text VARCHAR(250) NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pet_shop_product_images_order (product_id, sort_order, id),
  CONSTRAINT fk_pet_shop_product_images_product
    FOREIGN KEY (product_id) REFERENCES pet_shop_products(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pet_shop_product_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  storage_key CHAR(36) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  document_title VARCHAR(180) NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  uploaded_by_admin_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pet_shop_product_documents_key (storage_key),
  KEY idx_pet_shop_product_documents_product (product_id, created_at),
  CONSTRAINT fk_pet_shop_product_documents_product
    FOREIGN KEY (product_id) REFERENCES pet_shop_products(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_pet_shop_product_documents_admin
    FOREIGN KEY (uploaded_by_admin_id) REFERENCES users(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_pet_shop_product_documents_pdf CHECK (mime_type = 'application/pdf'),
  CONSTRAINT chk_pet_shop_product_documents_size CHECK (size_bytes > 0)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pet_shop_carts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pet_shop_carts_user (user_id),
  CONSTRAINT fk_pet_shop_carts_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pet_shop_cart_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cart_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pet_shop_cart_items_product (cart_id, product_id),
  KEY idx_pet_shop_cart_items_product (product_id),
  CONSTRAINT fk_pet_shop_cart_items_cart
    FOREIGN KEY (cart_id) REFERENCES pet_shop_carts(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_pet_shop_cart_items_product
    FOREIGN KEY (product_id) REFERENCES pet_shop_products(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_pet_shop_cart_items_quantity CHECK (quantity > 0)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
