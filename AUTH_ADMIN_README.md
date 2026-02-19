# Auth + Admin Approval System

## What it includes
- `/create` user creation page
- `/log` login page
- `/panel/:slug` protected user panel
- `/admin` admin dashboard
- `/admin/users` users list
- `/admin/users/:id` user profile + edits
- `/admin/edits` all edits with filters

## API endpoints
- `POST /api/auth/signup`
- `POST /api/auth/signin`
- `POST /api/auth/signout`
- `GET /api/me`
- `POST /api/edits`
- `GET /api/edits`
- `PATCH /api/edits/:id/approve`
- `PATCH /api/edits/:id/reject`

## Access control
- Users can access only their own `/panel/:slug`.
- Non-admin users cannot access `/admin*`.
- Only users with role `user` can submit edits.
- Admin users can approve/reject edits.

## Setup
1. Install Node.js 18+.
2. Install dependencies:
   - `npm install`
3. Start:
   - `npm start`
4. Open:
   - `http://localhost:3000/create`
   - `http://localhost:3000/log`

## Seeded accounts
- Admin:
  - `admin@example.com` / `Admin123!`
- User:
  - `user@example.com` / `User123!`

Override seeds with env vars:
- `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`
- `SEED_USER_NAME`, `SEED_USER_EMAIL`, `SEED_USER_PASSWORD`
- `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`
  - If set, this admin user is upserted on every app start (good for Railway).

Reset or promote a user manually:
- `npm run user:reset -- --email lrazalanas@gmail.com --password "YourPassword123!" --name "Anas" --role admin`

Set `SESSION_SECRET` in production.
