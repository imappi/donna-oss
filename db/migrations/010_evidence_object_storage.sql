insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'donna-evidence',
  'donna-evidence',
  false,
  10485760,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "donna evidence upload" on storage.objects;
drop policy if exists "donna evidence signed read" on storage.objects;
