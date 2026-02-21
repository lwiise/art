const { upsertUser } = require("../src/db");

function readArg(name) {
  const key = `--${name}`;
  const index = process.argv.findIndex((arg) => arg === key);
  if (index === -1) return "";
  return String(process.argv[index + 1] || "").trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const email = readArg("email").toLowerCase();
const password = readArg("password");
const name = readArg("name") || "User";
const role = (readArg("role") || "user").toLowerCase();

if (!email) fail("Missing required arg: --email");
if (!password) fail("Missing required arg: --password");
if (!["user", "vendor", "admin"].includes(role)) fail("Role must be user, vendor, or admin.");

const id = upsertUser({
  name,
  email,
  password,
  role,
});

console.log(`User saved. id=${id} email=${email} role=${role}`);
