const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const publicDirectory = path.resolve(__dirname, '..', 'public');
const storageDirectory = path.resolve(
  process.env.MEDICAL_SIGNATURE_STORAGE_DIR ||
  path.join(os.homedir(), '.pethub-sg', 'admin-signatures')
);

function isWithinDirectory(parentDirectory, candidateDirectory) {
  const relativePath = path.relative(parentDirectory, candidateDirectory);
  return relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath));
}

function assertStorageIsPrivate() {
  if (isWithinDirectory(publicDirectory, storageDirectory)) {
    throw new Error('Signature storage must be outside the public directory.');
  }
}

async function ensurePrivateStorageDirectory() {
  assertStorageIsPrivate();
  await fs.mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(storageDirectory, 0o700);
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return null;
  }

  const match = dataUrl.match(/^data:(image\/(png|jpeg|jpg));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1].toLowerCase(),
    base64: match[3]
  };
}

async function storeSignature(signatureDataUrl) {
  const parsed = parseDataUrl(signatureDataUrl);
  if (!parsed) {
    throw new Error('A valid PNG or JPEG signature image is required.');
  }

  const decoded = Buffer.from(parsed.base64, 'base64');
  if (decoded.length === 0 || decoded.length > 300 * 1024) {
    throw new Error('The handwritten signature is too large. Keep it under 300 KB.');
  }

  await ensurePrivateStorageDirectory();
  const storageKey = randomUUID();
  const filePath = path.join(storageDirectory, storageKey);

  let handle;
  try {
    handle = await fs.open(filePath, 'wx', 0o600);
    await handle.writeFile(decoded);
    await handle.close();
    handle = null;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new Error('The signature storage key collided. Please try again.');
    }
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        console.error('Signature file close failed:', closeError.code || 'UNKNOWN');
      }
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        console.error('Partial signature cleanup failed:', cleanupError.code || 'UNKNOWN');
      }
    }
    throw error;
  }

  return {
    storageKey,
    filePath,
    mimeType: parsed.mimeType,
    sizeBytes: decoded.length
  };
}

async function readSignature(storageKey) {
  if (typeof storageKey !== 'string' || !/^[0-9a-f-]+$/i.test(storageKey)) {
    throw new Error('Invalid signature storage key.');
  }

  await ensurePrivateStorageDirectory();
  const filePath = path.join(storageDirectory, storageKey);
  const file = await fs.readFile(filePath);
  return file;
}

async function removeSignature(storageKey) {
  if (typeof storageKey !== 'string' || !/^[0-9a-f-]+$/i.test(storageKey)) {
    return;
  }

  try {
    await fs.unlink(path.join(storageDirectory, storageKey));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = {
  storeSignature,
  readSignature,
  removeSignature,
  parseDataUrl,
  storageDirectory
};
