const {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes
} = require('crypto');
const QRCode = require('qrcode');
const { generateSecret, generateURI, verify } = require('otplib');

const ISSUER = 'Pomi';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
  const encoded = process.env.POMI_2FA_ENCRYPTION_KEY;
  if (!encoded) throw new Error('POMI_2FA_ENCRYPTION_KEY is not configured.');

  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('POMI_2FA_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

function encryptSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(part => part.toString('base64url')).join('.');
}

function decryptSecret(encrypted) {
  const [encodedIv, encodedTag, encodedCiphertext, extra] = encrypted.split('.');
  if (!encodedIv || !encodedTag || !encodedCiphertext || extra) {
    throw new Error('Stored authenticator secret has an invalid format.');
  }

  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    getEncryptionKey(),
    Buffer.from(encodedIv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function createRecoveryCodes(count = 10) {
  const codes = Array.from({ length: count }, () =>
    randomBytes(9).toString('hex').toUpperCase().match(/.{1,6}/g).join('-')
  );
  return {
    codes,
    verifiers: codes.map(code => hashRecoveryCode(code))
  };
}

function hashRecoveryCode(code) {
  const key = createHmac('sha256', getEncryptionKey())
    .update('pomi-recovery-code-verifier')
    .digest();
  const normalized = typeof code === 'string' ? code.replace(/-/g, '').toUpperCase() : '';
  return createHmac('sha256', key).update(normalized).digest('hex');
}

async function createQrCodeDataUrl(secret, label) {
  const uri = generateURI({
    issuer: ISSUER,
    label,
    secret,
    digits: 6,
    period: 30,
    algorithm: 'sha1'
  });
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240
  });
}

async function createEnrollmentData(label) {
  const secret = generateSecret();
  return {
    encryptedSecret: encryptSecret(secret),
    qrCodeDataUrl: await createQrCodeDataUrl(secret, label)
  };
}

async function verifyTotp(token, secret, afterTimeStep = 0) {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token)) {
    return { valid: false };
  }
  return verify({
    secret,
    token,
    digits: 6,
    period: 30,
    algorithm: 'sha1',
    epochTolerance: 30,
    afterTimeStep
  });
}

module.exports = {
  createEnrollmentData,
  createQrCodeDataUrl,
  createRecoveryCodes,
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  verifyTotp
};
