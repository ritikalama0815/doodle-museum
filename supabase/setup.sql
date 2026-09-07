-- Shared museum: any visitor can save and view doodles.
create table if not exists public.drawings (
  id uuid primary key default gen_random_uuid(),
  path text not null unique,
  caption text default '',
  flagged boolean default false,
  created_at timestamptz not null default now()
);

alter table public.drawings enable row level security;

drop policy if exists "drawings_public_select" on public.drawings;
drop policy if exists "drawings_public_insert" on public.drawings;

create policy "drawings_public_select"
on public.drawings
for select
using (true);

create policy "drawings_public_insert"
on public.drawings
for insert
with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert on public.drawings to anon, authenticated;

drop policy if exists "doodles_public_select" on storage.objects;
drop policy if exists "doodles_public_insert" on storage.objects;
drop policy if exists "doodles_public_update" on storage.objects;

create policy "doodles_public_select"
on storage.objects
for select
using (bucket_id = 'doodles');

create policy "doodles_public_insert"
on storage.objects
for insert
with check (
  bucket_id = 'doodles'
  and (
    name = 'gallery.json'
    or (storage.foldername(name))[1] = 'public'
  )
);

create policy "doodles_public_update"
on storage.objects
for update
using (bucket_id = 'doodles')
with check (bucket_id = 'doodles');

NOTIFY pgrst, 'reload schema';
