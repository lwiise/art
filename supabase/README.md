# Supabase Setup

1. Open your Supabase project SQL Editor.
2. Run `supabase/schema.sql`.
3. In Supabase Auth, ensure your admin user (`anaskaroti@gmail.com`) can sign in.
4. In the website, open the `Admin` section and click `Send Magic Link`.
5. Use `Seed Current Products` once to import the current hard-coded catalog.

Notes:
- Assets are stored in the public bucket `product-assets`.
- Admin rights are controlled by `public.admin_users`.
- Public site reads only `status = 'active'` products.
