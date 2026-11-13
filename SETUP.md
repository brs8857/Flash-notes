# Flash Notes — setting up accounts and sync (owner's guide)

Everything here happens **outside the code**: in the Supabase dashboard, the Google Cloud console and two small
edits to files in this repository. Allow about an hour. Nothing in the app changes for your users until step 6:
while `js/config.js` still holds its placeholders the site keeps working exactly like v1.2 (no sign-in, notes on
the device only).

What could not be tested before handing this over is listed at the end ("Not verified"). Please run the
checklist in step 8 before telling anyone the feature is live.

Dashboard labels move around; if a name below is not exactly what you see, look for the nearest match.

---

## 1. Create the Supabase project

1. Sign up at supabase.com and create a **new project** (the free plan is enough).
2. **Region: West EU (London) `eu-west-2`** so notes are stored in the UK. The region cannot be changed later.
3. Choose a strong database password and keep it in a password manager.
4. From **Project Settings → API** note down:
   - the **Project URL** (`https://<project-ref>.supabase.co`), and
   - the **anon / publishable key**.
   Never copy the `service_role` / secret key anywhere.
5. In your organisation's **Legal** settings, accept Supabase's **Data Processing Addendum (DPA)**. You need it
   for UK GDPR (Supabase is your processor).

## 2. Run the database migrations

The three files in `supabase/migrations/` create the tables, the row-level-security rules and the private image
bucket. They can be run more than once safely.

**Easiest (no tools):** Dashboard → **SQL Editor** → paste and run each file, in order:

1. `20261112000001_schema.sql`
2. `20261112000002_security.sql`
3. `20261112000003_storage.sql`

**Or with the Supabase CLI:** `supabase link --project-ref <project-ref>` then `supabase db push`.

Then check (SQL Editor):

```sql
select relname, relrowsecurity, relforcerowsecurity
from pg_class where relnamespace in ('public'::regnamespace, 'private'::regnamespace) and relkind = 'r';
-- expect 4 rows (profiles, docs, pages, write_rate), all true / true
select id, public from storage.buckets where id = 'note-images';   -- expect public = false
```

Also open **Database → Tables** and confirm the dashboard shows "RLS enabled" on `profiles`, `docs`, `pages`.

## 3. Turn on Google sign-in

### 3a. Google Cloud console (console.cloud.google.com)

1. Create a project (for example "Flash Notes").
2. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform → Branding/Audience"):
   - User type **External**.
   - App name "Flash Notes", your support email, the app's home page
     `https://brs8857.github.io/Flash-notes/`, privacy policy link
     `https://brs8857.github.io/Flash-notes/privacy.html`.
   - Authorised domains: `supabase.co` and `brs8857.github.io` (Google may only accept `github.io`).
   - **Scopes: only `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.** Add nothing else. These
     are non-sensitive scopes, so Google does not require a verification review for them.
   - Publish the app ("In production") when you are ready; while it is in "Testing" only the test users you list
     can sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorised JavaScript origins:** `https://brs8857.github.io`
   - **Authorised redirect URIs:** `https://<project-ref>.supabase.co/auth/v1/callback`
     (this is Supabase's callback, not the app's address; copy it from the Supabase Google provider page).
4. Copy the **Client ID** and **Client secret**.

### 3b. Supabase dashboard

1. **Authentication → Sign In / Providers → Google**: enable it, paste the Client ID and Client secret, save.
   Leave "Skip nonce checks" **off**.
2. On the same page, **turn every other provider off**, including **Email** (no passwords, no magic links) and
   **Anonymous sign-ins**. Google must be the only way in.
3. **Authentication → URL Configuration**:
   - **Site URL:** `https://brs8857.github.io/Flash-notes/`
   - **Redirect URLs (allow-list):** `https://brs8857.github.io/Flash-notes/`
     (add `http://localhost:8000/` too only if you test locally; remove it afterwards). Do not use wildcards.

## 4. Auth settings

Supabase dashboard → **Authentication**:

| Setting | Value | Why |
|---|---|---|
| Sessions → **JWT expiry** (access token lifetime) | **3600 s** or lower (900 s is fine) | A stolen access token stops working quickly. |
| Sessions → **Refresh token rotation** | **On** | Each refresh token works once. |
| Sessions → **Reuse interval** | 10 s (default) | A replayed refresh token revokes the whole session. |
| Sessions → Time-box / inactivity timeout (paid plans) | your choice | Optional extra. |
| **Allow manual linking** | **Off** | Nobody can attach a second identity to an account. |
| **Allow new users to sign up** | On | Needed for first sign-ins. |
| **Rate limits** | Keep the defaults or lower them: token refreshes, sign-ins/sign-ups per IP | Limits brute force and abuse of the Auth API. Read the current numbers on the Rate Limits page; they are Supabase's to define. |
| Attack protection → CAPTCHA | Optional | Not needed for Google-only sign-in. |

**Account linking (please read).** Supabase's documentation says Auth "automatically links identities with the
same email address to a single user", and does not offer a switch to turn that off. With Google as the only
provider there is nothing for it to link. Flash Notes also defends itself in two places, so a provider added
later can never silently merge accounts through an unverified email:

- the app refuses any session that does not have exactly one identity, from Google, with `email_verified = true`
  (`js/auth/guard.js`, tested);
- the database refuses notes to such an account whatever the app does (`private.account_ok()`, migration 2, tested).

If you ever add a provider, revisit both rules deliberately (SPEC "Auth & sync v2.0").

## 5. Deploy the delete-account function

"Delete my account" needs the service-role key, so it runs as a Supabase Edge Function (free plan includes
them). The key never leaves Supabase: functions receive it automatically as `SUPABASE_SERVICE_ROLE_KEY`.

```
npm install -g supabase            # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref <project-ref>
supabase secrets set ALLOWED_ORIGINS="https://brs8857.github.io"
supabase functions deploy delete-account
```

Do **not** pass `--no-verify-jwt`. (The dashboard's **Edge Functions → Deploy a new function → via editor** also
works: name it `delete-account`, paste `supabase/functions/delete-account/index.ts`, and add the
`ALLOWED_ORIGINS` secret under Edge Functions → Secrets.)

## 6. Fill in the app (three places, one value)

1. **`js/config.js`**: replace the two placeholders with your Project URL and anon/publishable key.
   These two values are public by design (every browser needs them); the database's row-level security is what
   protects the notes. The file refuses to start if you paste a service-role key by mistake.
2. **`index.html`**: in the `Content-Security-Policy` line replace `https://YOUR-PROJECT-REF.supabase.co` with
   your Project URL. If you skip this the browser blocks every request to Supabase and sign-in fails.
3. **`_headers`**: same replacement (only used if you ever host on Netlify or Cloudflare Pages).
4. **`sw.js`**: bump `VERSION` (for example `'v6'` → `'v7'`). Installed copies only pick up the new config
   after this, via the usual "Update available" prompt.
5. Fill in **`privacy.html`** (step 9), then commit and push.

Run `node tests/auth.test.mjs` after editing: two checks about "placeholders" will now fail (expected, they
describe the unconfigured state); every other check, including the CSP and secret-key checks, must still pass.

## 7. GitHub Pages notes

- Pages serves the repository as it is. There is no build step and no secret in the repository.
- Pages **cannot send security headers**. The app therefore carries its Content-Security-Policy and referrer
  policy in `<meta>` tags. Two protections are only possible as real headers and are therefore **not active on
  GitHub Pages**: `frame-ancestors` (clickjacking protection) and `Strict-Transport-Security`. `github.io` is
  HTTPS-only and on the browsers' HSTS preload list, which covers the second in practice. If you want both,
  host on Netlify or Cloudflare Pages, where `_headers` is applied automatically.
- The whole repository is public on Pages, including `tests/` and `supabase/`. That is fine: they contain no
  secrets, and the test harness cannot be switched on from the site (it only exists inside a Node test server).
- The address must match the Site URL and redirect allow-list exactly, including the capital `F` in
  `/Flash-notes/` and the trailing slash.

## 8. Verification checklist (do this on the live site)

Use two Google accounts (A and B) and, ideally, an iPad and a laptop.

- [ ] Open the site signed out: the login screen appears, the "Sign in with Google" button looks right in light
      and dark mode, and "Privacy policy" opens without signing in.
- [ ] Sign in as A. Google's consent screen lists **only** name, email address and profile picture/basic profile
      (Google groups these under "profile"); nothing about Drive, contacts or calendar.
- [ ] You land in the app. The address bar has no `?code=`.
- [ ] If instead you are sent back to the login screen with "email address isn't verified": run the SQL below.
      The app and the database both require `identity_data.email_verified = true` for the Google identity.
      ```sql
      select provider, identity_data ->> 'email_verified' as verified from auth.identities;
      select id, provider, email_verified from public.profiles;
      ```
- [ ] Create a notebook, write something, wait ten seconds. Dashboard → Table editor → `docs` and `pages` each
      have a row whose `owner_id` is A's id in Authentication → Users.
- [ ] Add a photo to a page. Storage → `note-images` has a folder named after A's user id; the bucket is
      marked private; opening the file's URL in a private window fails.
- [ ] Sign in as A on a second device: the notebook appears. Change it there; within about a minute (or on
      reopening the app) the first device has the change.
- [ ] Turn on aeroplane mode, open the app from the home screen: your notes open, you can write. Turn it off:
      Settings → Account goes back to "Up to date".
- [ ] Sign out: the login screen appears; signing in as **B** shows an empty library.
- [ ] As B, in the browser console, try to read A's data (replace the values):
      `await fetch('https://<project-ref>.supabase.co/rest/v1/docs?select=*', {headers:{apikey:'<anon key>', Authorization:'Bearer <B access token>'}}).then(r=>r.json())`
      → only B's rows. Without the `Authorization` header → an error or `[]`, never data.
- [ ] Settings → Download my notes and Export as Markdown both produce files.
- [ ] As B: Settings → Delete my account → type DELETE. B disappears from Authentication → Users, B's rows are
      gone from `profiles`, `docs`, `pages`, and B's storage folder is empty. A's data is untouched.
- [ ] Dashboard → **Advisors → Security**: no "RLS disabled" or "policy exists RLS disabled" findings.
- [ ] `grep -rn "service_role\|sb_secret_" --include=*.js --include=*.html .` finds only comments and the
      safety check in `js/config.js`, never a key.
- [ ] `grep -rn "console\." js/auth js/sync js/account.js js/ui/login.js js/ui/account.js` prints nothing
      (all logging goes through the masking logger in `js/log.js`).

## 9. Privacy page: what you must fill in

Open `privacy.html` and replace every yellow **[FILL IN]** marker, then delete the two dashed "note for the
owner" boxes:

| Marker | What to write |
|---|---|
| date | The date the page goes live |
| controller name, contact email, postal address | Who is legally responsible, and how to reach them |
| ICO registration number | Register at ico.org.uk (most organisations handling personal data pay a fee) or state your exemption |
| lawful basis | Usually "contract" (Art. 6(1)(b)); get advice because users are under 18 |
| Supabase region | "London, United Kingdom (eu-west-2)" if you followed step 1 |
| website host | "GitHub Pages (GitHub, Inc.)" |
| transfer safeguard | What Supabase's DPA says about transfers outside the UK |
| inactive-account rule; backup and log retention | Your decision, and your Supabase plan's backup/log retention |
| minimum age; what happens for younger children | Your decision. UK digital age of consent is 13. The app has **no age check** of its own |

This page is a careful draft, **not legal advice**. Because the app is aimed at school students, the ICO's
Children's Code applies; it expects a Data Protection Impact Assessment. Decisions that are yours, not the
code's: minimum age and how you establish it, lawful basis, retention periods, whether schools are involved
(a school may be a joint controller), ICO registration.

## 10. Day-to-day

- **Rate limiting in three layers:** Supabase Auth's own limits (step 4); the app uploads at most 600 rows a
  minute, one round every 2 seconds at most, and backs off up to 5 minutes after errors; the database refuses
  more than 1,200 row writes per user per minute and more than 2,000 notebooks / 20,000 pages per user.
- **Free-plan limits to watch** (check Supabase's pricing page for today's numbers; at the time of writing
  roughly 500 MB database, 1 GB storage): free projects are also **paused after about a week without activity**. A paused project means nobody can sign in or sync (notes on devices stay usable).
- **Never** put the service-role key in the repository, an issue, or a chat. If it leaks, rotate it in
  Project Settings → API.
- Upgrading supabase-js: see `vendor/README.md`.

## Not verified (be honest with yourself about these)

The builder had no Supabase project and no Google account to test with. Everything below was exercised only
against stand-ins and must be confirmed with the checklist above:

- The real Google OAuth round trip (consent screen, redirect, PKCE code exchange).
- A real Supabase project: PostgREST's handling of the upsert, real `auth.identities` contents
  (`email_verified`), the real Storage service and its policies, real token refresh.
- The Edge Function has never been deployed or run (Deno was not available); it was read and type-checked by
  eye only.
- The dashboard steps above were written from Supabase's and Google's documentation, not clicked through.
- Safari / iPadOS: all browser tests ran in desktop Chrome.

What **was** tested for real: the migrations and every RLS rule on a real Postgres engine (PGlite), sync and
conflict handling against the real IndexedDB code, and the app in Chrome against a fake Supabase.
