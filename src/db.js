const fs = require("fs");
const path = require("path");
const passwordUtils = require("./password");
const Database = require("better-sqlite3");

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.APP_DB_PATH
  ? path.resolve(process.env.APP_DB_PATH)
  : path.join(dataDir, "app.db");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

function tableSql(tableName) {
  const row = db
    .prepare("select sql from sqlite_master where type = 'table' and name = ?")
    .get(tableName);
  return row ? String(row.sql || "") : "";
}

function hasColumn(tableName, columnName) {
  const rows = db.prepare(`pragma table_info(${tableName})`).all();
  return rows.some((row) => String(row.name) === String(columnName));
}

function migrateLegacyUsersTable() {
  const sql = tableSql("users").toLowerCase();
  if (!sql) return;
  if (sql.includes("'vendor'")) return;

  db.exec(`
    pragma foreign_keys = off;
    begin transaction;

    create table users_new (
      id integer primary key autoincrement,
      name text not null,
      email text not null unique,
      password_hash text not null,
      role text not null check (role in ('admin', 'vendor', 'user')),
      slug text not null unique,
      created_at text not null default (datetime('now'))
    );

    insert into users_new (id, name, email, password_hash, role, slug)
    select
      id,
      name,
      email,
      password_hash,
      case when role = 'admin' then 'admin' else 'vendor' end as role,
      slug
    from users;

    drop table users;
    alter table users_new rename to users;

    commit;
    pragma foreign_keys = on;
  `);
}

db.exec(`
  create table if not exists users (
    id integer primary key autoincrement,
    name text not null,
    email text not null unique,
    password_hash text not null,
    role text not null check (role in ('admin', 'vendor', 'user')),
    slug text not null unique,
    created_at text not null default (datetime('now'))
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

  create table if not exists likes (
    user_id integer not null references users(id) on delete cascade,
    product_id text not null,
    created_at text not null default (datetime('now')),
    primary key (user_id, product_id)
  );

  create table if not exists comments (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    product_id text not null,
    content text not null,
    created_at text not null default (datetime('now')),
    updated_at text not null default (datetime('now'))
  );

  create table if not exists cart_items (
    user_id integer not null references users(id) on delete cascade,
    product_id text not null,
    quantity integer not null check (quantity >= 1),
    created_at text not null default (datetime('now')),
    updated_at text not null default (datetime('now')),
    primary key (user_id, product_id)
  );

  create table if not exists activity_log (
    id integer primary key autoincrement,
    actor_user_id integer references users(id) on delete set null,
    actor_role text not null check (actor_role in ('admin', 'vendor', 'user')),
    action_type text not null,
    target_type text,
    target_id text,
    details_json text not null default '{}',
    created_at text not null default (datetime('now'))
  );

  create table if not exists password_reset_tokens (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    token_hash text not null unique,
    expires_at text not null,
    used_at text,
    created_at text not null default (datetime('now')),
    created_by_admin_id integer references users(id) on delete set null
  );

  create table if not exists product_submissions (
    id integer primary key autoincrement,
    vendor_id integer not null references users(id) on delete cascade,
    product_id text not null,
    submission_type text not null check (submission_type in ('create', 'update')),
    snapshot_json text not null,
    base_snapshot_json text,
    vendor_note text,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    rejection_reason text,
    created_at text not null default (datetime('now')),
    reviewed_at text,
    reviewed_by integer references users(id) on delete set null
  );

  create index if not exists idx_users_slug on users(slug);
  create index if not exists idx_edits_user_id on edits(user_id);
  create index if not exists idx_edits_status on edits(status);
  create index if not exists idx_likes_product_id on likes(product_id);
  create index if not exists idx_comments_product_id on comments(product_id);
  create index if not exists idx_comments_user_created on comments(user_id, created_at desc);
  create index if not exists idx_cart_items_user_id on cart_items(user_id);
  create index if not exists idx_activity_log_actor_role_created on activity_log(actor_role, created_at desc);
  create index if not exists idx_activity_log_actor_user_created on activity_log(actor_user_id, created_at desc);
  create index if not exists idx_password_reset_user_created on password_reset_tokens(user_id, created_at desc);
  create index if not exists idx_password_reset_expires on password_reset_tokens(expires_at);
  create index if not exists idx_product_submissions_vendor_created on product_submissions(vendor_id, created_at desc);
  create index if not exists idx_product_submissions_status_created on product_submissions(status, created_at desc);
  create index if not exists idx_product_submissions_product_created on product_submissions(product_id, created_at desc);

  insert or ignore into site_state (id, sections_json, products_json)
  values (1, '{}', '[]');
`);

migrateLegacyUsersTable();

if (!hasColumn("users", "created_at")) {
  db.exec("alter table users add column created_at text;");
  db.exec("update users set created_at = coalesce(created_at, datetime('now'));");
}

if (!hasColumn("users", "status")) {
  db.exec("alter table users add column status text;");
  db.exec("update users set status = coalesce(status, 'active');");
}

if (!hasColumn("users", "last_login_at")) {
  db.exec("alter table users add column last_login_at text;");
}

if (!hasColumn("users", "password_changed_at")) {
  db.exec("alter table users add column password_changed_at text;");
  db.exec("update users set password_changed_at = coalesce(password_changed_at, created_at, datetime('now'));");
}

if (!hasColumn("users", "session_version")) {
  db.exec("alter table users add column session_version integer;");
  db.exec("update users set session_version = coalesce(session_version, 0);");
}

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

function upsertUser({ name, email, password, role }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const existing = db
    .prepare("select id, slug from users where email = ?")
    .get(normalizedEmail);
  const passwordHash = passwordUtils.hashSync(String(password || ""), 12);

  if (existing) {
    db.prepare(
      "update users set name = ?, password_hash = ?, role = ?, status = coalesce(status, 'active'), password_changed_at = datetime('now') where id = ?"
    ).run(name, passwordHash, role, existing.id);
    return existing.id;
  }

  const baseSlug = slugifyName(name);
  const slug = uniqueSlug(baseSlug);
  const info = db
    .prepare(
      "insert into users (name, email, password_hash, role, slug, status, password_changed_at, session_version) values (?, ?, ?, ?, ?, 'active', datetime('now'), 0)"
    )
    .run(name, normalizedEmail, passwordHash, role, slug);
  return info.lastInsertRowid;
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
  const passwordHash = passwordUtils.hashSync(password, 12);
  const info = db
    .prepare(
      "insert into users (name, email, password_hash, role, slug, status, password_changed_at, session_version) values (?, ?, ?, ?, ?, 'active', datetime('now'), 0)"
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
    name: process.env.SEED_VENDOR_NAME || "Vendor User",
    email: process.env.SEED_VENDOR_EMAIL || "vendor@example.com",
    password: process.env.SEED_VENDOR_PASSWORD || "Vendor123!",
    role: "vendor",
    allowExisting: true,
  });

  createUser({
    name: process.env.SEED_USER_NAME || "Site User",
    email: process.env.SEED_USER_EMAIL || "user@example.com",
    password: process.env.SEED_USER_PASSWORD || "User123!",
    role: "user",
    allowExisting: true,
  });

  const bootstrapAdminEmail = String(process.env.BOOTSTRAP_ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
  const bootstrapAdminPassword = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || "");
  if (bootstrapAdminEmail && bootstrapAdminPassword) {
    upsertUser({
      name: process.env.BOOTSTRAP_ADMIN_NAME || process.env.SEED_ADMIN_NAME || "Admin User",
      email: bootstrapAdminEmail,
      password: bootstrapAdminPassword,
      role: "admin",
    });
  }
}

seedDefaultUsers();

module.exports = {
  createUser,
  db,
  slugifyName,
  upsertUser,
};
