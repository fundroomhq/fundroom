# @fundroom/charts

Chart geometry for KPIs.

`layoutChart(spec)` answers a flat list of `VectorOp`s. The SPA draws each one as a React SVG
element; `DocumentRenderPort.renderVector` draws each one with pdf-lib and rasterises the page
through PDFium. **Neither interpreter makes a layout decision**, so the PNG in an investor's
inbox and the chart on the portal cannot disagree.

Pure: no DOM, no React, no pdf-lib, no sharp, no I/O, no palette, no locale. Colours arrive as
`#rrggbb` on the spec and numbers arrive already formatted by `yTickFormat`.

- Coordinates are top-left origin, pixels (SVG's convention). PDF's y flip happens once, in the
  render adapter.
- `y: null` is a **gap**: the line breaks and the bar is absent. It is never drawn as zero.
- `describedBy` is the screen-reader sentence and the email `alt` text — a chart must never be
  the only place a number exists.
- **CSP:** an SVG interpreter must use presentation attributes (`fill=`, `stroke=`), never a
  `style` attribute; `style-src 'self' 'nonce-…'` refuses inline styles inside the embed.
