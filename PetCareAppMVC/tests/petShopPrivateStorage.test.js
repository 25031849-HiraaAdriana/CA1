const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const storageDirectory = fs.mkdtemp(path.join(os.tmpdir(), 'pethub-shop-documents-'));
const previousStorageDirectory = process.env.PET_SHOP_DOCUMENT_STORAGE_DIR;
let privateStorage;

test('supporting PDFs are signature-checked and stored outside the public directory', async () => {
  const directory = await storageDirectory;
  process.env.PET_SHOP_DOCUMENT_STORAGE_DIR = directory;
  privateStorage = require('../helpers/privatePetShopStorage');

  const stored = await privateStorage.storePdfDocument({
    buffer: Buffer.from('%PDF-1.7\nmock document'),
    mimetype: 'application/pdf',
    originalname: '..\\supplier\\document.pdf'
  });
  assert.equal(stored.filename, 'document.pdf');
  assert.equal(path.dirname(stored.absolutePath), directory);
  assert.deepEqual(await privateStorage.readPdfDocument(stored.storageKey), Buffer.from('%PDF-1.7\nmock document'));
  await privateStorage.removePdfDocument(stored.storageKey);
  await assert.rejects(privateStorage.readPdfDocument(stored.storageKey), error => error.code === 'ENOENT');
});

test('supporting PDFs reject invalid content and unsafe storage keys', async () => {
  await storageDirectory;
  process.env.PET_SHOP_DOCUMENT_STORAGE_DIR = await storageDirectory;
  privateStorage = privateStorage || require('../helpers/privatePetShopStorage');

  await assert.rejects(
    privateStorage.storePdfDocument({
      buffer: Buffer.from('not a PDF'),
      mimetype: 'application/pdf',
      originalname: 'spoofed.pdf'
    }),
    error => error.code === 'INVALID_PRODUCT_DOCUMENT_CONTENT'
  );
  await assert.rejects(privateStorage.readPdfDocument('..\\secret'), /Invalid Pet Shop document key/);
});

after(async () => {
  if (previousStorageDirectory === undefined) delete process.env.PET_SHOP_DOCUMENT_STORAGE_DIR;
  else process.env.PET_SHOP_DOCUMENT_STORAGE_DIR = previousStorageDirectory;
  if (privateStorage) delete require.cache[require.resolve('../helpers/privatePetShopStorage')];
  await fs.rm(await storageDirectory, { recursive: true, force: true });
});
