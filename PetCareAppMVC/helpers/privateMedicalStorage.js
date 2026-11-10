const fs = require('fs/promises');
const { constants } = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const publicDirectory = path.resolve(__dirname, '..', 'public');
const storageDirectory = path.resolve(
  process.env.MEDICAL_RECORD_STORAGE_DIR ||
  path.join(os.homedir(), '.pethub-sg', 'medical-records')
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
    throw new Error('Medical record storage must be outside the public directory.');
  }
}

async function assertResolvedStorageIsPrivate() {
  assertStorageIsPrivate();
  const [resolvedPublicDirectory, resolvedStorageDirectory] = await Promise.all([
    fs.realpath(publicDirectory),
    fs.realpath(storageDirectory)
  ]);
  if (isWithinDirectory(resolvedPublicDirectory, resolvedStorageDirectory)) {
    throw new Error('Medical record storage must resolve outside the public directory.');
  }
}

async function storeOriginalDocument(buffer) {
  assertStorageIsPrivate();
  await fs.mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(storageDirectory, 0o700);
  await assertResolvedStorageIsPrivate();

  const storageKey = randomUUID();
  const filePath = path.join(storageDirectory, storageKey);

  let file;
  try {
    file = await fs.open(filePath, 'wx', 0o600);
    await file.writeFile(buffer);
    await file.close();
    file = null;
  } catch (writeError) {
    if (file) {
      try {
        await file.close();
      } catch (closeError) {
        console.error('Medical document file close failed:', closeError.code || 'UNKNOWN');
      }
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          writeError.cleanupCode = cleanupError.code || 'UNKNOWN';
        }
      }
    }
    throw writeError;
  }

  return storageKey;
}

async function removeOriginalDocument(storageKey) {
  if (typeof storageKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storageKey)) {
    throw new Error('Invalid private medical document key.');
  }

  await assertResolvedStorageIsPrivate();
  const filePath = path.join(storageDirectory, storageKey);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readOriginalDocument(storageKey) {
  if (typeof storageKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storageKey)) {
    throw new Error('Invalid private medical document key.');
  }

  await assertResolvedStorageIsPrivate();
  const filePath = path.join(storageDirectory, storageKey);
  const linkInfo = await fs.lstat(filePath);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    throw new Error('Private medical document is not a regular file.');
  }

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const file = await fs.open(filePath, constants.O_RDONLY | noFollow);
  try {
    const fileInfo = await file.stat();
    if (!fileInfo.isFile() || fileInfo.dev !== linkInfo.dev || fileInfo.ino !== linkInfo.ino) {
      throw new Error('Private medical document changed while it was being opened.');
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

module.exports = {
  storeOriginalDocument,
  removeOriginalDocument,
  readOriginalDocument
};
