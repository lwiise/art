-- Generic SQL schema matching the auth + admin approval system.
-- SQLite implementation is in src/db.js.

create table users (
  id integer primary key autoincrement,
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('user', 'admin')),
  slug text not null unique
);

create table edits (
  id integer primary key autoincrement,
  user_id integer not null references users(id) on delete cascade,
  title text not null,
  description text not null,
  payload text not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at text not null,
  approved_at text,
  approved_by integer references users(id)
);
