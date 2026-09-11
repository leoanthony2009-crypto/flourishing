# -*- coding: utf-8 -*-
"""Rebuild deploy/index.html from design/.

The original deploy bundle was produced by the Claude Design bundler, which is not
available here. This reproduces its output instead: it reads the existing bundle for the
asset manifest, re-applies the same transforms to the current design source, and writes a
new bundle. `--verify` re-runs the transform against the pristine design file and asserts
the result is byte-identical to the template already in the bundle, so the transform is
known-good before it is trusted with the edited source.

  python3 build.py --verify   # prove the transform reproduces the shipped bundle
  python3 build.py            # rebuild deploy/index.html from design/
"""
import base64, gzip, hashlib, io, json, os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DESIGN = os.path.join(ROOT, "design", "Bloom Principal Pulse.dc.html")
BUNDLE = os.path.join(ROOT, "deploy", "index.html")

# Local files the design source references, mapped to their manifest UUIDs.
ASSETS = {
    './support.js':                                                  '6a893f2c-0646-4072-92ef-4227dd8b506d',
    'https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js':        'b4f4dfa2-bff3-4e7c-beb2-1949b49c9ade',
    './image-slot.js':                                               'ca50e772-e49a-49d2-acc8-5142b5d465b1',
    'bloom-mark.png':                                                'd76015ff-ae9c-4cbe-8bac-d3b3a97dfd0b',
    'poui-mark.png':                                                 '9b6f6d48-7cd2-4c5d-b2ad-808fc975d939',
}
XIMPORT_FROM = ('./ios-frame.jsx ./shell.js',
                '9ded63c6-882f-4176-8f26-f2d34ca23d35#/ios-frame.jsx '
                'f5dd362d-640b-45aa-b12f-767e38f88a66#/shell.js')

# New in the Supabase build: the client library and our data layer, inlined like lucide.
SUPABASE_JS_UUID = 'c1a5f0de-77b2-4e9a-9a3d-2f6b8e41d7c0'
SUPABASE_API_UUID = 'e3b70c14-5d92-4a6f-8c21-9f4d0a6b3e58'

# sha256 of the template inside the bundle as it was originally shipped. --verify proves
# transform() reproduces it from the unedited design source, so the transform is trusted
# before it is applied to the edited one. Pinned as a digest rather than read from the
# bundle, so it keeps working once the bundle has been rebuilt.
ORIGINAL_TEMPLATE_SHA256 = 'a2315d80b26649ef225dac15c67cd65073fae728ccfe17e21557b4280f7dcf4c'


def blocks(bundle):
    """Locate the bundler's <script type="__bundler/*"> payload blocks."""
    out = {}
    for tag in ('manifest', 'ext_resources', 'page_order', 'template'):
        m = re.search(r'<script type="__bundler/%s"[^>]*>' % tag, bundle)
        i = m.end()
        j = bundle.index('</script>', i)
        out[tag] = (i, j)
    return out


def camelise(html):
    """The bundler re-serialises the DOM, so React-style camelCase attributes come back
    as sc-camel-* kebab attributes. Mirror that exactly."""
    def sub(m):
        name = m.group(1)
        kebab = re.sub(r'([A-Z])', lambda c: '-' + c.group(1).lower(), name)
        return ' sc-camel-%s=' % kebab
    return re.sub(r' ([a-z]+(?:[A-Z][a-zA-Z]*)+)=', sub, html)


def transform(design, font_style):
    h = design

    # Bare boolean attribute is re-serialised with an empty value.
    h = h.replace('<script type="text/x-dc" data-dc-script data-props=',
                  '<script type="text/x-dc" data-dc-script="" data-props=')
    h = h.replace(' crossorigin>', ' crossorigin="">')

    # The canvas thumbnail is a design-tool affordance; the bundler drops it.
    h = re.sub(r'<template id="__bundler_thumbnail">.*?</template>', '', h, flags=re.S)

    # Google Fonts <link> becomes an inline @font-face block over manifest'd woff2 files.
    h = re.sub(r'<link href="https://fonts\.googleapis\.com/css2\?[^"]*" rel="stylesheet">',
               font_style, h)

    h = h.replace('from="%s"' % XIMPORT_FROM[0], 'from="%s"' % XIMPORT_FROM[1])
    for src, ref in ASSETS.items():
        h = h.replace('"%s"' % src, '"%s"' % ref)

    # Attribute rename has to run before the doc-level whitespace fixes below, and must
    # not touch the logic <script>, which the bundler leaves alone.
    i = h.index('<script type="text/x-dc"')
    h = camelise(h[:i]) + h[i:]

    h = h.replace('<html>\n<head>\n', '<html><head>\n')

    # The serialiser closes the document with two blank lines and no trailing newline.
    # Constant for this document shape; --verify is what catches it if that ever changes.
    h = h.replace('</body>\n</html>\n', '\n\n</body></html>')
    return h


def main():
    verify = '--verify' in sys.argv
    bundle = io.open(BUNDLE, encoding='utf-8').read()
    b = blocks(bundle)
    template = json.loads(bundle[b['template'][0]:b['template'][1]])
    manifest = json.loads(bundle[b['manifest'][0]:b['manifest'][1]])

    # Recover the generated @font-face block from the shipped template.
    m = re.search(r'<style>/\* cyrillic-ext \*/.*?</style>', template, re.S)
    font_style = m.group(0)

    if verify:
        pristine = os.path.join(ROOT, 'build-reference.dc.html')
        if not os.path.exists(pristine):
            sys.exit('--verify needs %s (the unedited design source)' % pristine)
        got = transform(io.open(pristine, encoding='utf-8').read(), font_style)
        digest = hashlib.sha256(got.encode()).hexdigest()
        if digest == ORIGINAL_TEMPLATE_SHA256:
            print('verify: transform reproduces the originally shipped template '
                  '(sha256 %s)' % digest[:16])
            return
        io.open('/tmp/got.html', 'w', encoding='utf-8').write(got)
        sys.exit('verify FAILED: got sha256 %s, want %s (see /tmp/got.html)'
                 % (digest, ORIGINAL_TEMPLATE_SHA256))

    design = io.open(DESIGN, encoding='utf-8').read()

    # Inline supabase-js and the data layer rather than loading them from a CDN, so the
    # installed PWA has no third-party runtime dependency (same treatment as lucide).
    vendor = os.path.join(ROOT, 'vendor', 'supabase.js')
    api = os.path.join(ROOT, 'design', 'supabase-api.js')
    for path, ref in ((vendor, SUPABASE_JS_UUID), (api, SUPABASE_API_UUID)):
        raw = io.open(path, 'rb').read()
        manifest[ref] = {
            'mime': 'text/javascript',
            'compressed': True,
            'data': base64.b64encode(gzip.compress(raw, 9)).decode(),
        }
    design = design.replace(
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/dist/umd/supabase.js"></script>',
        '<script src="%s"></script>' % SUPABASE_JS_UUID)
    design = design.replace('<script src="./supabase-api.js"></script>',
                            '<script src="%s"></script>' % SUPABASE_API_UUID)

    out = transform(design, font_style)
    assert 'cdn.jsdelivr.net' not in out, 'supabase-js was not inlined'
    assert './supabase-api.js' not in out, 'supabase-api.js was not inlined'

    # The payload sits inside <script>, so any literal "</script>" in the JSON would end
    # the block early. Escape the slash the way the original bundler does.
    def enc(o):
        return json.dumps(o).replace('</', '<\\u002F')

    new = (bundle[:b['manifest'][0]] + '\n' + enc(manifest) + '\n  '
           + bundle[b['manifest'][1]:b['template'][0]] + '\n' + enc(out) + '\n  '
           + bundle[b['template'][1]:])
    io.open(BUNDLE, 'w', encoding='utf-8').write(new)
    print('rebuilt %s (%.1f MB)' % (BUNDLE, len(new) / 1e6))


if __name__ == '__main__':
    main()
