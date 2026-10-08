import { type MessageKey, matchLocale, t } from "@fundroom/i18n";
import { escapeHtml, inlineHtml, markdownToHtml, markdownToText } from "@fundroom/markdown";
import type { RenderedBlock } from "@fundroom/module-content";

/*
 * The update email (design/03 C1: rendered HTML, not an attachment; dark-mode-safe, inline
 * styles only, no web fonts, no tracking pixel — opens are E1.5 and consent-gated). Both
 * parts are built from the same filtered sections, so the text part is the wording of
 * record.
 *
 * **Gated data now travels with the mail** (E2.4 §10, decision D5). A `metric_grid` is
 * hydrated per recipient at send time and arrives as numbers in both parts, plus a chart PNG
 * fetched from `GET /metrics/chart/{token}.png`. What makes that image not a tracking pixel is
 * one property and nothing else: **the capability token names the set of metrics an audience
 * may see, never the reader.** An `<img>` in an email is a tracking pixel exactly when its URL
 * identifies one person; every recipient who sees the same metrics therefore gets a
 * byte-identical `<img src>`, so a fetch says "somebody in this group opened it" and can never
 * say who. Gating survives — the capability *is* the filter, applied once at send time — and
 * the open signal is never created. Anyone tempted to put a recipient id in that URL should
 * read D5 first: it would not tighten anything, it would manufacture the signal this product
 * refuses to collect.
 *
 * The numbers are in the **text** part too, and that is not belt-and-braces. Most clients
 * block remote images by default, so a KPI email whose figures exist only inside a PNG is a
 * KPI email with no figures. The picture carries the trend; the table carries the record.
 *
 * `document_list` still points at the web archive — a document is a file to open behind its
 * own per-viewer gates, not a number to read — and the `disclaimer` block is unchanged: its
 * text is not gated, and a legal legend has to travel with the mail.
 */
export interface EmailSection {
  readonly key: string;
  readonly title: string | null;
  readonly blocks: readonly RenderedBlock[];
}

export interface EmailInput {
  readonly title: string;
  readonly sections: readonly EmailSection[];
  readonly workspaceName: string;
  readonly archiveUrl: string;
  /** Absent on staff test sends and for staff recipients: security-relevant staff mail has no opt-out. */
  readonly unsubscribeUrl: string | undefined;
  readonly postalAddress: string | null;
  readonly footerNote: string | null;
  readonly test: boolean;
  readonly logoUrl?: string | null | undefined;
  /**
   * The recipient's language (E2.8): `user.locale ?? workspace.default_locale ?? "en"`. The
   * chrome (subject prefix, banner, links, footer, table headings) follows it and `<html lang>`
   * names it; the author's own title and sections are sent as written. Absent = `en`.
   */
  readonly locale?: string | undefined;
}

type Tr = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

/*
 * ESP click tracking rewrites every link through the provider's redirector. The unsubscribe
 * link must never be rewritten: the token in it is a capability, a redirect hop can break
 * one-click flows and security scanners, and "who clicked unsubscribe" is not engagement data.
 * Per-link opt-outs: Postmark honours `data-pm-no-track`, Amazon SES honours `ses:no-track`
 * (both are stripped or ignored by every other client). Resend has no per-link opt-out — with
 * Resend click tracking on, the link is rewritten like any other; the `List-Unsubscribe` header
 * (RFC 8058 one-click), which no provider rewrites, is the untracked path there.
 */
const NO_TRACK = "data-pm-no-track ses:no-track";

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const S = {
  body: "margin:0;padding:0;background-color:#f4f5f7;",
  container:
    "max-width:600px;margin:24px auto;background-color:#ffffff;border-radius:6px;padding:32px;font-family:Helvetica,Arial,sans-serif;color:#111827;",
  brand: "font-size:14px;font-weight:700;color:#374151;margin:0 0 4px;",
  h1: "font-size:24px;line-height:32px;font-weight:700;margin:0 0 24px;color:#111827;",
  h2: "font-size:18px;line-height:26px;font-weight:700;margin:24px 0 8px;color:#111827;",
  h3: "font-size:16px;line-height:24px;font-weight:700;margin:16px 0 8px;color:#111827;",
  h4: "font-size:15px;line-height:22px;font-weight:700;margin:12px 0 6px;color:#111827;",
  p: "font-size:16px;line-height:24px;margin:0 0 16px;color:#111827;",
  list: "font-size:16px;line-height:24px;margin:0 0 16px;padding-left:24px;color:#111827;",
  li: "margin:0 0 4px;",
  a: "color:#1d4ed8;text-decoration:underline;",
  code: "font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;background-color:#f4f5f7;padding:1px 4px;border-radius:3px;",
  muted: "font-size:13px;line-height:20px;color:#6b7280;margin:0 0 8px;",
  footer: "font-size:12px;line-height:18px;color:#6b7280;margin:0 0 4px;",
  banner:
    "font-size:13px;line-height:20px;background-color:#fef3c7;color:#92400e;padding:8px 12px;border-radius:4px;margin:0 0 16px;",
  hr: "border:0;border-top:1px solid #e5e7eb;margin:24px 0 16px;",
  disclaimer:
    "font-size:13px;line-height:20px;color:#4b5563;background-color:#f9fafb;border-left:3px solid #d1d5db;padding:12px 16px;margin:16px 0;",
  disclaimerLabel:
    "font-size:12px;line-height:18px;font-weight:700;color:#6b7280;margin:0 0 4px;text-transform:uppercase;letter-spacing:0.04em;",
  /*
   * The chart's frame, and the whole of this file's answer to dark mode.
   *
   * The PNG is rasterised once, on a light background (`CHART_PALETTE.background`), and a mail
   * client cannot invert the pixels inside it — so on a client-inverted dark body a bare
   * `<img>` is a white slab glued to a dark page. The frame makes that white deliberate: an
   * explicit light card with its own border and padding, the same treatment the disclaimer
   * block gets, so the chart reads as a *figure* printed on a page rather than as a rendering
   * accident. The border keeps an edge between the two even where a client repaints the card.
   *
   * The alternative — two PNGs and a `prefers-color-scheme` swap — was rejected, and not on
   * taste: it needs a `<style>` block with a media query (Gmail strips those) or `<picture>`
   * (patchy in mail), and it would mean a second capability token per send whose fetch is
   * conditioned on the reader's *theme*, which is a per-reader signal on a URL that D5 exists
   * to keep free of them. The honest limitation, stated so it is not rediscovered as a bug: in
   * a client that forces dark mode the chart stays light. It is legible, not native.
   */
  figure:
    "margin:0 0 16px;padding:8px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:6px;",
  chart: "display:block;width:100%;height:auto;border:0;",
  table:
    "width:100%;border-collapse:collapse;margin:0 0 12px;font-size:14px;line-height:20px;color:#111827;",
  th: "text-align:left;padding:6px 8px;border-bottom:1px solid #d1d5db;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;",
  td: "text-align:left;padding:6px 8px;border-bottom:1px solid #f4f5f7;",
  tdValue:
    "text-align:right;padding:6px 8px;border-bottom:1px solid #f4f5f7;font-weight:700;white-space:nowrap;",
} as const;

/** The body column: the container's 600px max-width less its 32px of padding on each side. */
const CONTENT_WIDTH = 536;

const inline = { a: S.a, code: S.code };

/** The `disclaimer` payload delivery hydrated onto the block, when there was one to hydrate. */
function hydratedDisclaimer(
  d: Record<string, unknown>,
): { title: string; versionNo: number; body: string } | undefined {
  const h = d["hydrated"];
  if (h === null || typeof h !== "object") return undefined;
  const { title, versionNo, body } = h as Record<string, unknown>;
  if (typeof body !== "string" || body === "" || typeof versionNo !== "number") return undefined;
  return { title: typeof title === "string" ? title : "", versionNo, body };
}

/** One row of the KPI table: what a reader needs to know a number, in both parts. */
interface EmailMetric {
  readonly name: string;
  readonly period: string;
  readonly value: string;
}

interface EmailChart {
  readonly url: string;
  /** `ChartLayout.describedBy` — the sentence that makes the picture readable without pixels. */
  readonly alt: string;
  /** CSS pixels. The PNG behind `url` is rendered larger; see `chartOf`. */
  readonly width: number;
  readonly height: number;
}

interface EmailMetricGrid {
  readonly metrics: readonly EmailMetric[];
  readonly chart: EmailChart | undefined;
}

/**
 * A metric's headline figure as prose.
 *
 * Values arrive as decimal **strings** (E2.4 §5: `numeric(20,6)` does not survive a JS float)
 * and are printed byte for byte — this file never parses one. Currency is written as its ISO
 * code rather than a symbol: a symbol table here would be a second copy of the one in
 * `modules/metrics`, free to drift, and "USD 1200000" is unambiguous in a plain-text part in a
 * way that "$1200000" is not once a workspace reports in two currencies.
 */
function metricFigure(m: Record<string, unknown>, tr: Tr): { period: string; value: string } {
  const latest = m["latest"];
  // What a metric with no point in range says. It is never rendered as a zero (§6, §10).
  const NO_VALUE = tr("updates.email.no_value");
  if (latest === null || typeof latest !== "object") return { period: "", value: NO_VALUE };
  const { periodLabel, value } = latest as Record<string, unknown>;
  if (typeof value !== "string" || value === "") return { period: "", value: NO_VALUE };
  const unit = typeof m["unit"] === "string" ? m["unit"] : "";
  const currency = typeof m["currency"] === "string" ? m["currency"] : "";
  const text =
    unit === "currency" && currency !== ""
      ? `${currency} ${value}`
      : unit === "percent"
        ? `${value}%`
        : value;
  return { period: typeof periodLabel === "string" ? periodLabel : "", value: text };
}

/**
 * The chart the hydrator minted for this audience, or `undefined` for "send the numbers only".
 *
 * Three refusals, each for a reason: a non-`https` URL never becomes an `<img src>` (a hydrated
 * payload is another module's output and this is the one place in the file that fetches
 * something); a missing description drops the image rather than shipping an undescribed one,
 * because the table beside it already carries every figure and a picture nobody can read is
 * pure weight; and the declared width is clamped to the body column so a chart can never push
 * the layout wider than the message.
 *
 * `width`/`height` are **CSS** pixels and the bitmap is expected to be larger — the route
 * rasterises at 2× so the image is sharp on a retina display (§12 C-G.2). Declaring both
 * attributes also reserves the right box while the image is still blocked, so accepting the
 * mail does not reflow the moment a reader clicks "show images".
 */
function chartOf(raw: unknown): EmailChart | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const url = typeof c["url"] === "string" ? c["url"] : "";
  if (!/^https:\/\/[^\s"<>]+$/iu.test(url)) return undefined;
  const alt = typeof c["alt"] === "string" ? c["alt"].trim() : "";
  if (alt === "") return undefined;
  const rawWidth = typeof c["width"] === "number" ? c["width"] : 0;
  const rawHeight = typeof c["height"] === "number" ? c["height"] : 0;
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) return undefined;
  if (rawWidth <= 0 || rawHeight <= 0) return undefined;
  const width = Math.min(Math.round(rawWidth), CONTENT_WIDTH);
  return { url, alt, width, height: Math.max(1, Math.round((rawHeight / rawWidth) * width)) };
}

/**
 * The `metric_grid` payload delivery hydrated onto the block (§10), or `undefined` when there
 * is none — a block that was never hydrated (the module is off, the hydrator threw) keeps the
 * archive link it has always had, which is the degradation path: a chart that cannot be drawn
 * must never take a send down.
 *
 * Ids this reader may not see are already absent from `metrics`; §10 drops them rather than
 * reporting them, so there is nothing here to count or hide.
 */
function hydratedMetricGrid(d: Record<string, unknown>, tr: Tr): EmailMetricGrid | undefined {
  const h = d["hydrated"];
  if (h === null || typeof h !== "object") return undefined;
  const payload = h as Record<string, unknown>;
  const raw = payload["metrics"];
  if (!Array.isArray(raw)) return undefined;
  const metrics = raw.flatMap((entry): EmailMetric[] => {
    if (entry === null || typeof entry !== "object") return [];
    const m = entry as Record<string, unknown>;
    const name = typeof m["name"] === "string" ? m["name"].trim() : "";
    return name === "" ? [] : [{ name, ...metricFigure(m, tr) }];
  });
  return { metrics, chart: chartOf(payload["chart"]) };
}

const archiveLinkHtml = (archiveUrl: string, label: string): string =>
  `<p style="${S.muted}"><a href="${escapeHtml(archiveUrl)}" style="${S.a}">${label}</a></p>`;

function metricGridHtml(grid: EmailMetricGrid, archiveUrl: string, tr: Tr): string {
  const image =
    grid.chart === undefined
      ? ""
      : `<div style="${S.figure}"><img src="${escapeHtml(grid.chart.url)}" alt="${escapeHtml(
          grid.chart.alt,
        )}" width="${grid.chart.width}" height="${grid.chart.height}" style="${S.chart}"></div>`;
  const rows = grid.metrics
    .map(
      (m) =>
        `<tr><td style="${S.td}">${escapeHtml(m.name)}</td><td style="${S.td}">${escapeHtml(
          m.period,
        )}</td><td style="${S.tdValue}">${escapeHtml(m.value)}</td></tr>`,
    )
    .join("");
  const table = `<table cellpadding="0" cellspacing="0" border="0" style="${S.table}"><thead><tr><th scope="col" style="${S.th}">${escapeHtml(tr("updates.email.metric_column"))}</th><th scope="col" style="${S.th}">${escapeHtml(tr("updates.email.period_column"))}</th><th scope="col" style="${S.th}">${escapeHtml(tr("updates.email.value_column"))}</th></tr></thead><tbody>${rows}</tbody></table>`;
  return `${image}${table}<p style="${S.muted}"><a href="${escapeHtml(archiveUrl)}" style="${S.a}">${escapeHtml(tr("updates.email.kpis_link"))}</a></p>`;
}

/** Column widths are computed from the content: a table nobody can line up is not a table. */
function metricGridText(grid: EmailMetricGrid, archiveUrl: string, tr: Tr): string {
  const rows: (readonly [string, string, string])[] = [
    [
      tr("updates.email.metric_column"),
      tr("updates.email.period_column"),
      tr("updates.email.value_column"),
    ],
    ...grid.metrics.map((m) => [m.name, m.period, m.value] as const),
  ];
  const nameWidth = Math.max(...rows.map((r) => r[0].length));
  const periodWidth = Math.max(...rows.map((r) => r[1].length));
  const lines = rows.map((r) =>
    `${r[0].padEnd(nameWidth)}  ${r[1].padEnd(periodWidth)}  ${r[2]}`.trimEnd(),
  );
  return `${lines.join("\n")}\n\n${tr("updates.email.kpis_link")}: ${archiveUrl}`;
}

function blockHtml(block: RenderedBlock, archiveUrl: string, tr: Tr): string {
  const d = block.data as Record<string, unknown>;
  switch (block.type) {
    case "rich_text":
      return markdownToHtml(String(d["text"] ?? ""), {
        ...inline,
        h2: S.h2,
        h3: S.h3,
        h4: S.h4,
        p: S.p,
        list: S.list,
        li: S.li,
      });
    case "faq": {
      const items = Array.isArray(d["items"])
        ? (d["items"] as { question?: unknown; answer?: unknown }[])
        : [];
      return items
        .map(
          (it) =>
            `<p style="${S.p}"><strong>${escapeHtml(String(it.question ?? ""))}</strong><br>${inlineHtml(String(it.answer ?? ""), inline)}</p>`,
        )
        .join("");
    }
    case "team": {
      const members = Array.isArray(d["members"])
        ? (d["members"] as { name?: unknown; title?: unknown }[])
        : [];
      return `<ul style="${S.list}">${members
        .map(
          (mm) =>
            `<li style="${S.li}"><strong>${escapeHtml(String(mm.name ?? ""))}</strong>${mm.title ? ` — ${escapeHtml(String(mm.title))}` : ""}</li>`,
        )
        .join("")}</ul>`;
    }
    case "embed": {
      const url = typeof d["url"] === "string" ? d["url"] : "";
      const title = typeof d["title"] === "string" && d["title"] ? d["title"] : url;
      return /^https:\/\//iu.test(url)
        ? `<p style="${S.p}"><a href="${escapeHtml(url)}" style="${S.a}">${escapeHtml(title)}</a></p>`
        : "";
    }
    case "disclaimer": {
      // Hydrated at send time (service/delivery.ts). A disclaimer the workspace has not
      // written yet resolves to nothing, and nothing is what the email says.
      const h = hydratedDisclaimer(d);
      if (h === undefined) return "";
      return `<div style="${S.disclaimer}"><p style="${S.disclaimerLabel}">${escapeHtml(
        `${h.title} · v${h.versionNo}`,
      )}</p>${markdownToHtml(h.body, {
        ...inline,
        h2: S.h3,
        h3: S.h4,
        h4: S.h4,
        p: S.muted,
        list: S.list,
        li: S.li,
      })}</div>`;
    }
    case "metric_grid": {
      // Hydrated per recipient at send time (service/delivery.ts). Three outcomes, all of them
      // deliberate: numbers (with a chart when one could be minted for this audience); nothing
      // at all when this reader may see none of the block's metrics — a "View the KPIs" link
      // onto a page with no KPIs would advertise the existence of numbers §10 just dropped;
      // and the archive link when hydration did not happen, which is where the send lands if
      // anything in the chart path fails.
      //
      // Returning `""` is only half of that second outcome, and on its own it was not enough:
      // the section heading above the block is emitted by `renderUpdateEmail`, which used to
      // write it unconditionally, so a reader admitted to none of these metrics still received
      // a bare `KPIs` heading with nothing beneath it — advertising precisely what the block
      // had just refused to. `renderUpdateEmail` now drops a section whose blocks all rendered
      // nothing, heading included, in both parts. The suppression is therefore the whole
      // section, not merely the block.
      const grid = hydratedMetricGrid(d, tr);
      if (grid !== undefined)
        return grid.metrics.length === 0 ? "" : metricGridHtml(grid, archiveUrl, tr);
      return archiveLinkHtml(archiveUrl, escapeHtml(tr("updates.email.kpis_link")));
    }
    case "document_list":
      return archiveLinkHtml(archiveUrl, escapeHtml(tr("updates.email.documents_link")));
    default:
      return "";
  }
}

function blockText(block: RenderedBlock, archiveUrl: string, tr: Tr): string {
  const d = block.data as Record<string, unknown>;
  switch (block.type) {
    case "rich_text":
      return markdownToText(String(d["text"] ?? ""));
    case "faq": {
      const items = Array.isArray(d["items"])
        ? (d["items"] as { question?: unknown; answer?: unknown }[])
        : [];
      return items
        .map((it) => `${String(it.question ?? "")}\n${String(it.answer ?? "")}`)
        .join("\n\n");
    }
    case "team": {
      const members = Array.isArray(d["members"])
        ? (d["members"] as { name?: unknown; title?: unknown }[])
        : [];
      return members
        .map((mm) => `- ${String(mm.name ?? "")}${mm.title ? `, ${String(mm.title)}` : ""}`)
        .join("\n");
    }
    case "embed": {
      const url = typeof d["url"] === "string" ? d["url"] : "";
      return /^https:\/\//iu.test(url) ? url : "";
    }
    case "disclaimer": {
      const h = hydratedDisclaimer(d);
      return h === undefined ? "" : `${h.title} (v${h.versionNo})\n${markdownToText(h.body)}`;
    }
    case "metric_grid": {
      // The text part is the wording of record, and most clients block remote images by
      // default — so this table, not the PNG, is where a reader is guaranteed to find the
      // numbers. Same three outcomes as the HTML part, for the same reasons.
      const grid = hydratedMetricGrid(d, tr);
      if (grid === undefined) return `${tr("updates.email.kpis_link")}: ${archiveUrl}`;
      return grid.metrics.length === 0 ? "" : metricGridText(grid, archiveUrl, tr);
    }
    case "document_list":
      return `${tr("updates.email.documents_link")}: ${archiveUrl}`;
    default:
      return "";
  }
}

/**
 * The parts of one section that survive, or `undefined` for a section that must not appear at
 * all — **not even its heading**.
 *
 * The case this exists for is a `metric_grid` whose reader may see none of its metrics. The
 * block renders nothing rather than a "View the KPIs" link, because a link onto a page with no
 * KPIs would advertise the existence of the numbers §10 just dropped; a bare `KPIs` heading
 * over empty space advertises exactly the same thing, so the heading goes with it.
 *
 * A section with **no blocks at all** keeps its heading, and the distinction is deliberate.
 * The editor makes such a section — `apps/web/src/modules/content/admin.tsx` adds one with
 * `blocks: []` — and `SectionSchema` puts no `.min(1)` on the array, so a heading-only section
 * is a document an author can write and save. Nothing was gated away from this reader there,
 * so there is nothing to conceal: the rule is "everything under this heading was suppressed",
 * never "this heading has nothing under it".
 */
function sectionParts(rendered: readonly string[], blockCount: number): string[] | undefined {
  const kept = rendered.filter((part) => part.trim().length > 0);
  return blockCount > 0 && kept.length === 0 ? undefined : kept;
}

export function renderUpdateEmail(input: EmailInput): RenderedEmail {
  const tr: Tr = (key, vars) => t(input.locale, key, vars);
  const lang = matchLocale(input.locale) ?? "en";
  const subject = tr(input.test ? "updates.email.subject_test" : "updates.email.subject", {
    workspace: input.workspaceName,
    title: input.title,
  });
  const sectionsHtml = input.sections
    .map((s) => {
      const parts = sectionParts(
        s.blocks.map((b) => blockHtml(b, input.archiveUrl, tr)),
        s.blocks.length,
      );
      if (parts === undefined) return "";
      const title = s.title ? `<h2 style="${S.h2}">${escapeHtml(s.title)}</h2>` : "";
      return `${title}${parts.join("\n")}`;
    })
    .filter((h) => h.length > 0)
    .join("\n");
  const sectionsText = input.sections
    .map((s) => {
      const parts = sectionParts(
        s.blocks.map((b) => blockText(b, input.archiveUrl, tr)),
        s.blocks.length,
      );
      if (parts === undefined) return "";
      const body = parts.join("\n\n");
      return s.title ? `${s.title.toUpperCase()}\n\n${body}` : body;
    })
    .filter((t) => t.trim().length > 0)
    .join("\n\n\n");

  const footerLines: string[] = [];
  if (input.footerNote) footerLines.push(input.footerNote);
  footerLines.push(tr("updates.email.sent_by", { workspace: input.workspaceName }));
  if (input.postalAddress) footerLines.push(input.postalAddress);
  const html = `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(subject)}</title></head>
<body style="${S.body}">
<div style="${S.container}">
${input.test ? `<p style="${S.banner}">${escapeHtml(tr("updates.email.test_banner"))}</p>` : ""}
${input.logoUrl ? `<img src="${escapeHtml(input.logoUrl)}" alt="" height="40" style="display:block;margin:0 0 8px;">` : ""}
<p style="${S.brand}">${escapeHtml(input.workspaceName)}</p>
<h1 style="${S.h1}">${escapeHtml(input.title)}</h1>
${sectionsHtml}
<hr style="${S.hr}">
<p style="${S.footer}"><a href="${escapeHtml(input.archiveUrl)}" style="${S.a}">${escapeHtml(tr("updates.email.view_on_web"))}</a></p>
${footerLines.map((l) => `<p style="${S.footer}">${escapeHtml(l)}</p>`).join("\n")}
${
  input.unsubscribeUrl
    ? `<p style="${S.footer}"><a href="${escapeHtml(input.unsubscribeUrl)}" ${NO_TRACK} style="${S.a}">${escapeHtml(tr("updates.email.unsubscribe"))}</a></p>`
    : ""
}
</div>
</body></html>`;

  const text = [
    input.test ? `${tr("updates.email.test_banner_text")}\n` : "",
    `${input.workspaceName}`,
    `${input.title}`,
    "",
    sectionsText,
    "",
    "--",
    `${tr("updates.email.view_on_web")}: ${input.archiveUrl}`,
    ...footerLines,
    ...(input.unsubscribeUrl
      ? [`${tr("updates.email.unsubscribe")}: ${input.unsubscribeUrl}`]
      : []),
  ]
    .filter((l) => l !== undefined)
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { subject, html, text };
}
