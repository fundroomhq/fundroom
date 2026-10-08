# @fundroom/branding

What a workspace's brand implies: the `--sh-*` overrides derived from the small brand it stores, the same derivation
as a DTCG theme document, the contrast report the admin form warns from, the bundled font stacks,
and the header sniffing that decides what a logo actually is. No dependencies, no I/O — so the
server (SSR token injection, email, `GET /branding/theme`) and the browser (the live preview in the
admin form) cannot disagree about what a brand looks like.

## Stored brand in, derived tokens out

`brandTokens(brand, mode)` and `brandThemeTokens(brand)` take a `BrandInput` — an accent colour, a
`BrandFontName`, a `BrandRadiusName` — and return the `--sh-*` overrides for one palette or both.
Only those names are emitted; every other token keeps the stylesheet default.

The inversion is the point. A workspace cannot post a token map, so it cannot set its foreground to
its background and make its own portal unreadable, and a token the design system gains later needs
no migration of anything stored — the derivation simply starts emitting it. `brandThemeDocument`
is the DTCG shape one might expect as the *input*; it is an **output**, served by
`GET /branding/theme`.

## AA is a property of the derivation, not advice in the UI

Each palette is solved separately: a colour legible on white is usually too dark on the near-black
dark ground, so the same hue moves in opposite directions rather than being reused. The fill and
its label are solved *together* and scored on the weaker of the two ratios, because pushing a fill
just far enough to clear the page background strands mid-tone hues — reds and violets especially —
exactly where neither white nor ink reads on top of it. `contrastReport()` exists so the form can
warn about a hue that cannot reach AA against both grounds; it is a second opinion, never the safety
mechanism. `derivePalette(hex, mode)` is the colour half on its own.

## OKLCH is the working space

`srgbToOklch` / `oklchToSrgb` / `withLightness` / `adjustForContrast` work in OKLCH because scaling
lightness there preserves hue: the same move in HSL swings blues towards purple and turns yellows
muddy, which is precisely the wrong failure for a brand colour. A colour that leaves the sRGB gamut
after adjustment is mapped back by reducing chroma via bisection rather than by clipping channels —
clipping shifts hue towards a primary and can collapse two different brand colours onto one value.

## Fonts are a choice from bundled stacks

`BRAND_FONT_STACKS` is six stacks composed only of fonts already present on mainstream desktop and
mobile systems (`BRAND_RADIUS_VALUES` is the three corner radii). No uploads and no CDN links: the
app CSP allows no external font origin, and self-hosting a customer's licensed webfont needs an
upload pipeline and a licence story this epic does not own. Nothing is downloaded, so there is no
flash of unstyled text. It is a real limit on "look like the company" and it is recorded here
rather than hidden.

## The bytes decide what a logo is

`checkLogo(bytes)` sniffs PNG, JPEG and WebP headers, reads the intrinsic size from them, and
refuses anything outside `LOGO_MIN_PIXELS`…`LOGO_MAX_PIXELS` or over `LOGO_MAX_BYTES`. The
request's `Content-Type` and any file name are ignored: both are attacker-controlled, and the
sniffed value is later echoed as a response header on a public route. SVG is deliberately absent
from the allow-list — it is a script carrier, and serving one from our own origin would hand a
workspace admin stored XSS on the portal. Nothing is decoded or re-encoded, so there is no image
library in the dependency tree and a header that does not parse is simply rejected (`sniffImage`
is the raw form). `logoCandidates(html, baseUrl)` only *extracts* Open Graph and favicon URLs out
of someone else's markup; the caller re-validates every one through the SSRF guard.
