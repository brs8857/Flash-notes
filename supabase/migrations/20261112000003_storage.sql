-- Flash Notes v2.0 — private image storage.
-- Photos and pasted images are kept out of the page jsonb (a page would otherwise be re-uploaded in full,
-- megabytes at a time, after every pen stroke). They go to a PRIVATE bucket at
--   <auth.uid()>/<sha-256 of the image>.<jpg|png>
-- and the page stores only the reference "fln-img:<sha-256>.<ext>". Objects are immutable (no update).
-- Nothing in this bucket is ever public and there are no signed or public URLs: the app downloads with
-- the user's own bearer token.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('note-images', 'note-images', false, 8388608, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists note_images_select_own on storage.objects;
create policy note_images_select_own on storage.objects for select to authenticated
  using (bucket_id = 'note-images' and (select private.account_ok())
         and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists note_images_insert_own on storage.objects;
create policy note_images_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'note-images'
              and (select private.account_ok())
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and name ~ '^[0-9a-f-]{36}/[0-9a-f]{64}\.(jpg|png)$');

drop policy if exists note_images_delete_own on storage.objects;
create policy note_images_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- No UPDATE policy and no policy for anon: objects cannot be overwritten, moved or read without signing in.
