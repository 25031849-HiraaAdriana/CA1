const path = require('path');
const dotenv = require('dotenv');

const environmentFile = path.join(__dirname, '..', '.env');

function loadEnvironment() {
  dotenv.config({ path: environmentFile, quiet: true });
}

function requireSessionSecret(environment = process.env) {
  const secret = environment.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('Set SESSION_SECRET to a random value of at least 32 bytes before starting Pomi.');
  }
  return secret;
}

module.exports = { environmentFile, loadEnvironment, requireSessionSecret };
