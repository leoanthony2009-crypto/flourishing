# vendor

`supabase.js` — the UMD build of `@supabase/supabase-js@2.58.0`, taken verbatim from the npm
tarball (`npm pack @supabase/supabase-js@2.58.0`, then `package/dist/umd/supabase.js`).

It is vendored rather than loaded from a CDN because `build.py` inlines it into
`deploy/index.html`, the same treatment the original bundle gives lucide. That keeps the
installed PWA free of third-party runtime dependencies and keeps it working offline up to the
point where it needs the API.

To update: re-pack the new version, replace this file, bump the version in
`design/Bloom Principal Pulse.dc.html` (the CDN `<script>` the design canvas uses) and in
`build.py`'s replacement string, then `npm run check`.
