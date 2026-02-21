const crypto = require("crypto");

let bcrypt = null;
try {
  // Optional at runtime. In environments where bcryptjs is unavailable,
  // we fall back to scrypt-based hashes.
  bcrypt = require("bcryptjs");
} catch {
  bcrypt = null;
}

const FALLBACK_PREFIX = "scrypt$";

function hashWithScrypt(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${FALLBACK_PREFIX}${salt}$${derived}`;
}

function compareWithScrypt(password, hash) {
  if (typeof hash !== "string" || !hash.startsWith(FALLBACK_PREFIX)) return false;
  const parts = hash.split("$");
  if (parts.length !== 3) return false;
  const salt = parts[1];
  const expected = parts[2];
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(derived, "hex");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function hashSync(password, rounds = 12) {
  if (bcrypt) {
    return bcrypt.hashSync(String(password), rounds);
  }
  return hashWithScrypt(password);
}

function compareSync(password, hash) {
  if (typeof hash !== "string" || !hash) return false;
  if (hash.startsWith(FALLBACK_PREFIX)) {
    return compareWithScrypt(password, hash);
  }
  if (bcrypt) {
    return bcrypt.compareSync(String(password), hash);
  }
  return false;
}

module.exports = {
  hashSync,
  compareSync,
};
