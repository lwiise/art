-- Supabase schema for the FNN Art admin panel
-- Run this in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.admin_users (
  email text primary key,
  created_at timestamptz not null default now()
);

insert into public.admin_users (email)
values ('anaskaroti@gmail.com')
on conflict (email) do nothing;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  gallery_type text not null check (gallery_type in ('furniture', 'books', 'art', 'sculpture')),
  status text not null default 'active',
  sort_order integer not null default 0,
  name text not null,
  category text,

  artist_name text,
  artist_role text,
  artist_image_url text,
  artist_bio text,

  image_url text,
  media_images jsonb not null default '[]'::jsonb,
  model_url text,

  theme text,
  color text,
  size text,
  tag text,
  kicker text,

  material text,
  dimensions text,
  store_name text,
  store_lng double precision,
  store_lat double precision,

  medium text,
  period text,
  era text,
  year integer,
  rating numeric(3,1),
  rating_count text,
  base_price numeric(12,2),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_products_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_set_products_updated_at on public.products;
create trigger trg_set_products_updated_at
before update on public.products
for each row
execute function public.set_products_updated_at();

alter table public.admin_users enable row level security;
alter table public.products enable row level security;

drop policy if exists "Authenticated can read admin_users" on public.admin_users;
create policy "Authenticated can read admin_users"
on public.admin_users
for select
to authenticated
using (true);

drop policy if exists "Public read active products" on public.products;
create policy "Public read active products"
on public.products
for select
to anon, authenticated
using (status = 'active');

drop policy if exists "Admin read all products" on public.products;
create policy "Admin read all products"
on public.products
for select
to authenticated
using (
  exists (
    select 1
    from public.admin_users au
    where lower(au.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Admin insert products" on public.products;
create policy "Admin insert products"
on public.products
for insert
to authenticated
with check (
  exists (
    select 1
    from public.admin_users au
    where lower(au.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Admin update products" on public.products;
create policy "Admin update products"
on public.products
for update
to authenticated
using (
  exists (
    select 1
    from public.admin_users au
    where lower(au.email) = lower(auth.jwt() ->> 'email')
  )
)
with check (
  exists (
    select 1
    from public.admin_users au
    where lower(au.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Admin delete products" on public.products;
create policy "Admin delete products"
on public.products
for delete
to authenticated
using (
  exists (
    select 1
    from public.admin_users au
    where lower(au.email) = lower(auth.jwt() ->> 'email')
  )
);

insert into storage.buckets (id, name, public)
values ('product-assets', 'product-assets', true)
on conflict (id) do update set public = true;

drop policy if exists "Public read product-assets" on storage.objects;
create policy "Public read product-assets"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'product-assets');

drop policy if exists "Admin upload product-assets" on storage.objects;
create policy "Admin upload product-assets"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'product-assets'
  and exists (
    select 1
    from public.admin_users au
    where lower(au.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Admin update product-assets" on storage.objects;
create policy "Admin update product-assets"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'product-assets'
  and exists (
    select 1
    from public.admin_users au
    where lower(au.email) = lower(auth.jwt() ->> 'email')
  )
)
with check (
  bucket_id = 'product-assets'
  and exists (
    select 1
    from public.admin_users au
    where lower(au.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Admin delete product-assets" on storage.objects;
create policy "Admin delete product-assets"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'product-assets'
  and exists (
    select 1
    from public.admin_users au
    where lower(au.email) = lower(auth.jwt() ->> 'email')
  )
);
