# vendor/

Third-party code is kept here as plain files because Flash Notes has no build step and loads nothing from
other sites (the Content-Security-Policy forbids it).

| File | What | Version | Licence |
|---|---|---|---|
| `perfect-freehand.js` | stroke outlines | see file header | MIT (`perfect-freehand.LICENSE`) |
| `fonts/patrick-hand-latin-400-normal.woff2` | handwriting font for text boxes | — | OFL (`fonts/PatrickHand-OFL.txt`) |
| `supabase-js.js` | Supabase client (sign-in, database, storage) | **2.119.0** (pinned) | MIT (`supabase-js.LICENSE`) |

## supabase-js.js

One ES module made from the official npm package `@supabase/supabase-js@2.119.0` and its own dependencies
(auth-js, postgrest-js, storage-js, functions-js, realtime-js, all 2.119.0; `@supabase/phoenix` 0.4.5;
iceberg-js; tslib). Nothing was edited by hand. It contains no `eval` and no `new Function`.

It is only ever loaded with a dynamic `import()` from `js/auth/auth.js`, after the app is on screen.

### Rebuild / verify

```
mkdir /tmp/sb && cd /tmp/sb && npm init -y
npm install --save-exact @supabase/supabase-js@2.119.0 esbuild@0.28.2
npx esbuild node_modules/@supabase/supabase-js/dist/index.mjs \
  --bundle --format=esm --minify --platform=browser --legal-comments=none --outfile=out.js
tail -n +2 /path/to/Flash-notes/vendor/supabase-js.js | sha256sum    # the file without its banner line
sha256sum out.js                                                      # must be the same
```

Expected SHA-256 of the bundle without the banner line:
`ead7baf615455c1907ddb73b48339bd11542a3e0d4474e643e52c70881623369`
(whole file, with banner: `41ddeee35f36e9071a398861704a50d896a8f6df6c3cdc5693c88a1546c380ca`).

The first line of the file is a one-line banner comment naming the version and licence; add it back after
rebuilding. To upgrade: change the version in the commands above, rebuild, update this table, the banner,
the version in `supabase/functions/delete-account/index.ts`, and bump `VERSION` in `sw.js`.
