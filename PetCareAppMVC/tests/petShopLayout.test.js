const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

test('Shop and Dashboard styles define compact desktop and responsive mobile layouts', async () => {
  const [shopCss, dashboardCss, adminCss] = await Promise.all([
    fs.readFile(path.join(root, 'public', 'css', 'pet-shop.css'), 'utf8'),
    fs.readFile(path.join(root, 'public', 'css', 'pethub-dashboard.css'), 'utf8'),
    fs.readFile(path.join(root, 'public', 'css', 'pomi-admin.css'), 'utf8')
  ]);
  assert.match(shopCss, /\.shop-banner\s*\{[^}]*height:\s*clamp\(200px,\s*20vw,\s*250px\)/s);
  assert.match(shopCss, /\.shop-banner-photo\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(shopCss, /\.shop-brand-logo-link,\s*\.shop-store-logo-link\s*\{[^}]*transition:\s*opacity/s);
  assert.match(shopCss, /\.shop-product-grid\s*\{[^}]*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(shopCss, /@media\s*\(max-width:\s*620px\)[\s\S]*?\.shop-product-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(shopCss, /@media\s*\(max-width:\s*620px\)[\s\S]*?\.shop-storefront-filters\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
  assert.match(shopCss, /\.shop-product-image\s*\{[^}]*width:\s*100%;[^}]*aspect-ratio:\s*1\s*\/\s*1/s);
  assert.match(shopCss, /\.shop-product-image img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*contain/s);
  assert.match(shopCss, /\.shop-brand-logo-link img\[hidden\],\s*\.shop-store-logo-link img\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(dashboardCss, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(180px,\s*195px\)\)/);
  assert.match(dashboardCss, /\.dashboard-shop-image-wrap\s*\{[^}]*width:\s*100%;[^}]*aspect-ratio:\s*1\s*\/\s*1/s);
  assert.match(dashboardCss, /\.dashboard-shop-image-wrap img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*contain/s);
  assert.match(dashboardCss, /@media\s*\(max-width:\s*760px\)[\s\S]*?\.dashboard-shop-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*195px\)\)/);
  assert.match(dashboardCss, /@media\s*\(max-width:\s*380px\)[\s\S]*?\.dashboard-shop-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*195px\)/);
  assert.match(dashboardCss, /\.dashboard-shop-history\s*\{[^}]*border-top:/s);
  assert.match(dashboardCss, /\.dashboard-page \.passport-photo\s*\{[^}]*width:\s*130px;[^}]*height:\s*158px;[^}]*border-radius:\s*50%\s*\/\s*43%/s);
  assert.match(dashboardCss, /\.dashboard-page \.passport-card:hover \.passport-photo > img/);
  assert.match(dashboardCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.dashboard-page \.passport-card/);
  assert.match(adminCss, /\.pomi-admin-dashboard-card\s*\{[^}]*min-height:\s*112px;[^}]*border-radius:\s*22px/s);
  assert.match(adminCss, /\.pomi-admin-dashboard-card:focus-visible/);
  assert.match(adminCss, /\.pomi-admin-dashboard-card:active/);
});
