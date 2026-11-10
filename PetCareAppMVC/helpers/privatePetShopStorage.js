const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const publicDirectory = path.resolve(__dirname, '..', 'public');
const storageDirectory = path.resolve(
  process.env.PET_SHOP_DOCUMENT_STORAGE_DIR ||
  path.join(os.homedir(), '.pethub-sg', 'pet-shop-documents')
);

function assertPrivateStorage() {
  const relativePath = path.relative(publicDirectory, storageDirectory);
  if (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  ) {
    throw new Error('Pet Shop document storage must be outside the public directory.');
  }
}

async function ensurePrivateDirectory() {
  assertPrivateStorage();
  await fs.mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(storageDirectory, 0o700);
}

function normalizeFilename(filename) {
  const basename = path.win32.basename(path.basename(String(filename || '').replace(/\0/g, '')));
  const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return Array.from(cleaned || 'supplier-document.pdf').slice(0, 255).join('');
}

async function storePdfDocument(file) {
  if (!file || !Buffer.isBuffer(file.buffer) ||
      file.buffer.length < 5 ||
      file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-' ||
      file.mimetype !== 'application/pdf' ||
      file.buffer.length > 5 * 1024 * 1024) {
    const error = new Error('Supporting documents must be valid PDF files no larger than 5 MB.');
    error.code = 'INVALID_PRODUCT_DOCUMENT_CONTENT';
    throw error;
  }
  await ensurePrivateDirectory();
  const storageKey = randomUUID();
  const absolutePath = path.join(storageDirectory, storageKey);
  await fs.writeFile(absolutePath, file.buffer, { flag: 'wx', mode: 0o600 });
  return {
    storageKey,
    absolutePath,
    filename: normalizeFilename(file.originalname),
    sizeBytes: file.buffer.length,
    mimeType: 'application/pdf'
  };
}

async function readPdfDocument(storageKey) {
  if (typeof storageKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storageKey)) {
    throw new Error('Invalid Pet Shop document key.');
  }
  await ensurePrivateDirectory();
  return fs.readFile(path.join(storageDirectory, storageKey));
}

async function removePdfDocument(storageKey) {
  if (typeof storageKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storageKey)) {
    throw new Error('Invalid Pet Shop document key.');
  }
  try {
    await fs.unlink(path.join(storageDirectory, storageKey));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = {
  storePdfDocument,
  readPdfDocument,
  removePdfDocument,
  normalizeFilename,
  storageDirectory
};
