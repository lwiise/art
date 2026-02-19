const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "app.db");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

db.exec(`
  create table if not exists users (
    id integer primary key autoincrement,
    name text not null,
    email text not null unique,
    password_hash text not null,
    role text not null check (role in ('user', 'admin')),
    slug text not null unique
  );

  create table if not exists edits (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    title text not null,
    description text not null,
    payload text not null default '{}',
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    created_at text not null default (datetime('now')),
    approved_at text,
    approved_by integer references users(id)
  );

  create table if not exists site_state (
    id integer primary key check (id = 1),
    sections_json text not null default '{}',
    products_json text not null default '[]',
    updated_at text not null default (datetime('now')),
    updated_by integer references users(id)
  );

  create index if not exists idx_users_slug on users(slug);
  create index if not exists idx_edits_user_id on edits(user_id);
  create index if not exists idx_edits_status on edits(status);

  insert or ignore into site_state (id, sections_json, products_json)
  values (1, '{}', '[]');
`);

function slugifyName(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "user";
}

function uniqueSlug(baseSlug) {
  let slug = baseSlug;
  let i = 2;
  const getStmt = db.prepare("select 1 from users where slug = ?");
  while (getStmt.get(slug)) {
    slug = `${baseSlug}-${i}`;
    i += 1;
  }
  return slug;
}

function createUser({ name, email, password, role, allowExisting = false }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const existing = db.prepare("select id from users where email = ?").get(normalizedEmail);
  if (existing) {
    if (allowExisting) {
      return existing.id;
    }
    const err = new Error("Email already exists.");
    err.code = "EMAIL_EXISTS";
    throw err;
  }
  const baseSlug = slugifyName(name);
  const slug = uniqueSlug(baseSlug);
  const passwordHash = bcrypt.hashSync(password, 12);
  const info = db
    .prepare(
      "insert into users (name, email, password_hash, role, slug) values (?, ?, ?, ?, ?)"
    )
    .run(name, normalizedEmail, passwordHash, role, slug);
  return info.lastInsertRowid;
}

function seedDefaultUsers() {
  createUser({
    name: process.env.SEED_ADMIN_NAME || "Admin User",
    email: process.env.SEED_ADMIN_EMAIL || "admin@example.com",
    password: process.env.SEED_ADMIN_PASSWORD || "Admin123!",
    role: "admin",
    allowExisting: true,
  });

  createUser({
    name: process.env.SEED_USER_NAME || "John Doe",
    email: process.env.SEED_USER_EMAIL || "user@example.com",
    password: process.env.SEED_USER_PASSWORD || "User123!",
    role: "user",
    allowExisting: true,
  });
}

seedDefaultUsers();

module.exports = {
  createUser,
  db,
  slugifyName,
};
