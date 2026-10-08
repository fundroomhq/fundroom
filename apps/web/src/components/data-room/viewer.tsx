import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Input,
  Label,
  LoadingState,
  PageHeader,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Keyboard,
  Lock,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../../lib/api.js";
import { useWebConfig } from "../../lib/config-context.js";
import {
  type DataRoomDocumentDetail,
  dataRoomDocumentQuery,
  dataRoomFileUrl,
  dataRoomSearchQuery,
} from "../../lib/data-room-queries.js";
import { useQaStatus } from "../../lib/qa-queries.js";
import { useViewAs } from "../../lib/queries.js";
import { useDwellHeartbeat } from "../../lib/use-dwell-heartbeat.js";
import { m } from "../../paraglide/messages.js";
import { gateLabel } from "../access/common.js";
import { ErrorAlert } from "../error-alert.js";
import { AskQuestionButton } from "./qa/ask-dialog.js";
import { QaTargetPanel } from "./qa/target-panel.js";
import { useRovingToolbar } from "./use-roving-toolbar.js";
import { PageTextLayer, ShortcutsDialog } from "./viewer-parts.js";

/*
 * The secure viewer (design/03 B2, ADR-0015): pages are server-rendered images with the
 * viewer's watermark burned in, fetched lazily from the API on the portal origin. No original
 * bytes; downloads only when the document's policy and the grant allow. Screenshots cannot be
 * prevented: the watermark and the audit trail are the deterrent.
 *
 * Keyboard-complete (E2.8, WCAG 2.2 AA; map in docs/accessibility.md): the stage is a focusable
 * scroll region (arrows / Page Up/Down / Home / End page, + = - 0 zoom), the toolbar is one tab
 * stop with roving focus, a go-to-page field reaches every page at every viewport, `?` opens the
 * shortcut list, and each mounted page carries a visually hidden text layer for screen readers.
 */
const ZOOMS = [50, 75, 100, 150, 200] as const;
type Zoom = (typeof ZOOMS)[number] | "fit";
const WINDOW = 1; // pages mounted on each side of the current page
const TOOLBAR_KEYS = ["prev", "next", "zoom-out", "fit", "zoom-in", "help"] as const;

/** `backTo` is a splat under `/`, e.g. `data-room` (the admin surface passes `admin/data-room`). */
export function DocumentViewer({ documentId, backTo }: { documentId: string; backTo: string }) {
  const detail = useQuery(dataRoomDocumentQuery(documentId));
  if (detail.isPending) return <LoadingState label={m.common_loading()} />;
  if (detail.isError) return <ErrorAlert error={detail.error} />;
  return <Loaded doc={detail.data} backTo={backTo} />;
}

function scrollBehavior(): ScrollBehavior {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  } catch {
    return "auto";
  }
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function Loaded({ doc, backTo }: { doc: DataRoomDocumentDetail; backTo: string }) {
  const config = useWebConfig();
  const id = doc.document.id;
  const versionId = doc.currentVersion?.id ?? null;
  const pageCount = doc.currentVersion?.pageCount ?? 0;
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [target, setTarget] = useState("");
  const [targetError, setTargetError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const search = useQuery(dataRoomSearchQuery(id, submitted));
  const searchId = useId();
  const gotoId = useId();
  const gotoErrorId = useId();
  const stageRef = useRef<HTMLElement>(null);
  const pageRefs = useRef(new Map<number, HTMLElement>());
  const helpReturn = useRef<HTMLElement | null>(null);
  const viewed = useRef(false);
  const toolbar = useRovingToolbar(TOOLBAR_KEYS);

  // Dwell tracking (E1.5): no-ops unless the workspace's analytics mode is `engagement`.
  useDwellHeartbeat({
    resourceId: id,
    versionId,
    page,
    enabled: doc.access.allowed && doc.availability.viewable && pageCount > 0,
  });

  // Under view-as (E2.7) the visit is not the investor's: no "viewed" stamp, no download.
  const viewingAs = useViewAs() !== null;

  // Q&A (E3.3) is the investor portal's; the admin surface reuses this viewer without it.
  const investorSurface = !backTo.startsWith("admin/");
  const qa = useQaStatus(investorSurface);
  const showQa = investorSurface && qa.enabled && doc.access.allowed;

  useEffect(() => {
    if (viewed.current || !doc.access.allowed || viewingAs) return;
    viewed.current = true;
    void api()
      .POST("/data-room/documents/{id}/viewed", { params: { path: { id } } })
      .catch(() => {});
  }, [id, doc.access.allowed, viewingAs]);

  /**
   * Show page `n`. `focusPage` moves focus to the page figure (thumbnails, search hits, go-to):
   * the reader lands on what they asked for, and a screen reader reads its caption and text.
   * Keyboard paging on the stage keeps focus on the stage. `preventScroll` + one explicit
   * scroll avoids a double jump; reduced motion gets an instant scroll.
   */
  const goTo = useCallback(
    (n: number, opts: { focusPage?: boolean } = {}) => {
      const next = Math.min(Math.max(1, n), Math.max(1, pageCount));
      setPage(next);
      const el = pageRefs.current.get(next);
      if (!el) return;
      if (opts.focusPage) el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "start", behavior: scrollBehavior() });
    },
    [pageCount],
  );

  // Track the current page as the reader scrolls.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio > 0.5) {
            const n = Number((e.target as HTMLElement).dataset["page"]);
            if (Number.isFinite(n)) setPage(n);
          }
        }
      },
      { root: stageRef.current, threshold: [0.5] },
    );
    for (const el of pageRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const openHelp = useCallback(() => {
    helpReturn.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHelpOpen(true);
  }, []);

  // `?` opens the shortcut list from anywhere in the viewer except a text field.
  const hasPages = doc.access.allowed && doc.availability.viewable && pageCount > 0;
  useEffect(() => {
    if (!hasPages) return;
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "?" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable(e.target) || helpOpen) return;
      e.preventDefault();
      openHelp();
    };
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
  }, [hasPages, helpOpen, openHelp]);

  // E3.12: an AI citation links to the page it quotes (`#page-<n>`): open there, once.
  const hash = useRouterState({ select: (s) => s.location.hash });
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current || !hasPages) return;
    const match = /^page-(\d{1,6})$/u.exec(hash);
    if (match === null) return;
    jumped.current = true;
    goTo(Number(match[1]), { focusPage: true });
  }, [hash, hasPages, goTo]);

  const zoomBy = (dir: 1 | -1) => setZoom((z) => stepZoom(z, dir));

  const onStageKey = (e: KeyboardEvent<HTMLElement>) => {
    // Leave browser/OS shortcuts (Ctrl/Cmd + =, Alt + ←) alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "ArrowRight":
      case "PageDown":
        goTo(page + 1);
        break;
      case "ArrowLeft":
      case "PageUp":
        goTo(page - 1);
        break;
      case "Home":
        goTo(1);
        break;
      case "End":
        goTo(pageCount);
        break;
      case "+":
      case "=":
        zoomBy(1);
        break;
      case "-":
      case "_":
        zoomBy(-1);
        break;
      case "0":
        setZoom("fit");
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "touch") swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || e.pointerType !== "touch") return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) goTo(dx < 0 ? page + 1 : page - 1);
  };

  const onGoTo = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(target.trim());
    if (!Number.isInteger(n) || n < 1 || n > pageCount) {
      setTargetError(m.dataroom_goto_invalid({ total: String(pageCount) }));
      return;
    }
    setTargetError(null);
    goTo(n, { focusPage: true });
  };

  const width = zoom === "fit" ? "100%" : `${zoom}%`;
  const zoomLabel =
    zoom === "fit" ? m.dataroom_fit_width() : m.dataroom_zoom_percent({ n: String(zoom) });
  const pages = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount]);
  const { availability, access } = doc;
  const downloadHref =
    availability.download && !viewingAs ? dataRoomFileUrl(config.apiBase, id, "download") : null;
  const atFirst = page <= 1;
  const atLast = page >= pageCount;
  const atMinZoom = zoom === ZOOMS[0];
  const atMaxZoom = zoom === ZOOMS[ZOOMS.length - 1];
  const focusRing =
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
  const ariaDisabled = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${doc.document.index} ${doc.document.title}`.trim()}
        description={
          doc.currentVersion
            ? m.dataroom_viewer_meta({
                pages: String(pageCount),
                version: String(doc.currentVersion.versionNo),
              })
            : m.dataroom_no_preview()
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link
                to={backTo.startsWith("admin/") ? "/admin/$" : "/$"}
                params={{ _splat: backTo.replace(/^admin\//u, "") }}
              >
                <ArrowLeft aria-hidden="true" />
                {m.common_back()}
              </Link>
            </Button>
            {downloadHref ? (
              <Button asChild variant="outline" size="sm">
                <a href={downloadHref}>
                  <Download aria-hidden="true" />
                  {availability.download === "watermarked"
                    ? m.dataroom_download_watermarked()
                    : m.dataroom_download()}
                </a>
              </Button>
            ) : null}
            {showQa && qa.canAsk && !viewingAs ? (
              <AskQuestionButton
                targetKind="document"
                targetId={id}
                targetTitle={doc.document.title}
                label={m.dataroom_qa_ask_document()}
              />
            ) : null}
          </div>
        }
      />

      {!access.allowed && access.reason === "gated" ? (
        <Alert>
          <Lock aria-hidden="true" />
          <AlertTitle>{m.dataroom_gated_title()}</AlertTitle>
          <AlertDescription>
            {m.dataroom_gated_body()}{" "}
            {access.pendingGates.map((g) => gateLabel(g.kind, g.detail)).join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      {access.allowed && !availability.viewable ? (
        <Alert>
          <AlertTitle>{unavailableTitle(availability.reason)}</AlertTitle>
          <AlertDescription>{unavailableBody(availability.reason)}</AlertDescription>
        </Alert>
      ) : null}

      {hasPages ? (
        <div className="grid gap-4 lg:grid-cols-[8rem_1fr_16rem]">
          <nav
            aria-label={m.dataroom_pages_nav()}
            className="hidden max-h-[75vh] overflow-y-auto p-1 lg:block"
          >
            <ol className="space-y-1">
              {pages.map((n) => (
                <li key={n}>
                  <button
                    type="button"
                    onClick={() => goTo(n, { focusPage: true })}
                    aria-current={n === page ? "page" : undefined}
                    className={`w-full rounded border px-2 py-1 text-left text-sm tabular-nums ${focusRing} ${n === page ? "border-primary bg-accent" : "hover:bg-accent/40"}`}
                  >
                    {/* Decorative: the button's text names the page. Lazily loaded, so only
                        the thumbnails scrolled into the list are fetched. */}
                    <img
                      src={dataRoomFileUrl(config.apiBase, id, `pages/${n}`)}
                      alt=""
                      className="mb-1 aspect-[3/4] w-full rounded bg-muted object-cover object-top"
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                    />
                    {m.dataroom_page_n({ n: String(n) })}
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          <section aria-label={m.dataroom_viewer_label()} className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div
                ref={toolbar.ref}
                className="flex flex-wrap items-center gap-2"
                role="toolbar"
                aria-label={m.dataroom_toolbar()}
                onKeyDown={toolbar.onKeyDown}
                onFocus={toolbar.onFocus}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-roving-key="prev"
                  tabIndex={toolbar.tabIndexFor("prev")}
                  onClick={() => (atFirst ? undefined : goTo(page - 1))}
                  aria-disabled={atFirst || undefined}
                  className={ariaDisabled}
                  aria-label={m.dataroom_prev_page()}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <span className="text-sm tabular-nums" aria-live="polite">
                  {m.dataroom_page_of({ n: String(page), total: String(pageCount) })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-roving-key="next"
                  tabIndex={toolbar.tabIndexFor("next")}
                  onClick={() => (atLast ? undefined : goTo(page + 1))}
                  aria-disabled={atLast || undefined}
                  className={ariaDisabled}
                  aria-label={m.dataroom_next_page()}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
                <span className="mx-2 h-6 border-l" aria-hidden="true" />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-roving-key="zoom-out"
                  tabIndex={toolbar.tabIndexFor("zoom-out")}
                  aria-label={m.dataroom_zoom_out()}
                  aria-disabled={atMinZoom || undefined}
                  className={ariaDisabled}
                  onClick={() => (atMinZoom ? undefined : zoomBy(-1))}
                >
                  <ZoomOut aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant={zoom === "fit" ? "secondary" : "outline"}
                  size="sm"
                  data-roving-key="fit"
                  tabIndex={toolbar.tabIndexFor("fit")}
                  aria-pressed={zoom === "fit"}
                  onClick={() => setZoom("fit")}
                >
                  {m.dataroom_fit_width()}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-roving-key="zoom-in"
                  tabIndex={toolbar.tabIndexFor("zoom-in")}
                  aria-label={m.dataroom_zoom_in()}
                  aria-disabled={atMaxZoom || undefined}
                  className={ariaDisabled}
                  onClick={() => (atMaxZoom ? undefined : zoomBy(1))}
                >
                  <ZoomIn aria-hidden="true" />
                </Button>
                <Badge variant="outline" aria-hidden="true">
                  {zoomLabel}
                </Badge>
                <span className="sr-only" role="status">
                  {m.dataroom_zoom_status({ level: zoomLabel })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-roving-key="help"
                  tabIndex={toolbar.tabIndexFor("help")}
                  aria-haspopup="dialog"
                  aria-keyshortcuts="?"
                  aria-label={m.dataroom_shortcuts_button()}
                  onClick={openHelp}
                >
                  <Keyboard aria-hidden="true" />
                </Button>
              </div>
              <form onSubmit={onGoTo} className="flex items-center gap-2" noValidate>
                <Label htmlFor={gotoId} className="text-sm">
                  {m.dataroom_goto_label()}
                </Label>
                <Input
                  id={gotoId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={pageCount}
                  step={1}
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    if (targetError) setTargetError(null);
                  }}
                  aria-invalid={targetError ? true : undefined}
                  aria-describedby={targetError ? gotoErrorId : undefined}
                  className="h-8 w-20"
                />
                <Button type="submit" variant="outline" size="sm">
                  {m.dataroom_goto_button()}
                </Button>
              </form>
            </div>
            <p
              id={gotoErrorId}
              className="mb-2 text-sm text-destructive empty:hidden"
              aria-live="assertive"
            >
              {targetError ?? ""}
            </p>
            <section
              ref={stageRef}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable scroll region so keyboard paging works without the mouse (WAI-ARIA scrollable region pattern)
              tabIndex={0}
              onKeyDown={onStageKey}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              className={`max-h-[75vh] overflow-auto rounded-md border bg-muted/40 p-2 ${focusRing}`}
              aria-label={m.dataroom_stage_label()}
            >
              {pages.map((n) => {
                const mounted = Math.abs(n - page) <= WINDOW;
                return (
                  <figure
                    key={n}
                    data-page={n}
                    tabIndex={-1}
                    ref={(el) => {
                      if (el) pageRefs.current.set(n, el);
                      else pageRefs.current.delete(n);
                    }}
                    className={`mx-auto mb-3 rounded last:mb-0 ${focusRing}`}
                    style={{ width, minHeight: "24rem" }}
                    aria-labelledby={`${id}-page-${n}`}
                  >
                    {mounted ? (
                      <img
                        src={dataRoomFileUrl(config.apiBase, id, `pages/${n}`)}
                        alt={m.dataroom_page_alt({ n: String(n), title: doc.document.title })}
                        className="w-full select-none rounded bg-white shadow"
                        draggable={false}
                        onContextMenu={(e) => e.preventDefault()}
                        loading="lazy"
                      />
                    ) : (
                      <div className="h-96 w-full rounded bg-muted" aria-hidden="true" />
                    )}
                    {mounted && versionId ? (
                      <PageTextLayer documentId={id} versionId={versionId} pageNo={n} />
                    ) : null}
                    <figcaption id={`${id}-page-${n}`} className="sr-only">
                      {m.dataroom_page_n({ n: String(n) })}
                    </figcaption>
                  </figure>
                );
              })}
            </section>
          </section>

          <aside aria-label={m.dataroom_search_results()} className="space-y-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSubmitted(q.trim());
              }}
              className="space-y-1"
            >
              <Label htmlFor={searchId}>{m.dataroom_search_label()}</Label>
              <div className="flex gap-2">
                <Input
                  id={searchId}
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={m.dataroom_search_placeholder()}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  aria-label={m.dataroom_search_button()}
                >
                  <Search aria-hidden="true" />
                </Button>
              </div>
            </form>
            {search.isFetching ? (
              <p className="text-sm text-muted-foreground">{m.common_loading()}</p>
            ) : null}
            {search.data ? (
              search.data.hits.length === 0 ? (
                <p className="text-sm text-muted-foreground">{m.dataroom_search_none()}</p>
              ) : (
                <ul className="space-y-1" aria-label={m.dataroom_search_results()}>
                  {search.data.hits.map((h) => (
                    <li key={`${h.pageNo}-${h.snippet}`}>
                      <button
                        type="button"
                        onClick={() => goTo(h.pageNo, { focusPage: true })}
                        className={`w-full rounded border p-2 text-left text-sm hover:bg-accent/40 ${focusRing}`}
                      >
                        <span className="mr-1 font-medium tabular-nums">
                          {m.dataroom_page_n({ n: String(h.pageNo) })}
                        </span>
                        <span className="text-muted-foreground">{h.snippet}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </aside>
          <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} returnFocus={helpReturn} />
        </div>
      ) : null}

      {/* Below the grid, not in the aside: the aside only exists when there are pages. */}
      {showQa ? <QaTargetPanel targetKind="document" targetId={id} /> : null}
    </div>
  );
}

function stepZoom(zoom: Zoom, dir: 1 | -1): Zoom {
  const current = zoom === "fit" ? 100 : zoom;
  const i = ZOOMS.indexOf(current as (typeof ZOOMS)[number]);
  const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + dir))];
  return next ?? "fit";
}

function unavailableTitle(reason: DataRoomDocumentDetail["availability"]["reason"]): string {
  switch (reason) {
    case "processing":
      return m.dataroom_processing_title();
    case "unscanned":
      return m.dataroom_unscanned_title();
    case "infected":
      return m.dataroom_infected_title();
    case "unsupported":
      return m.dataroom_unsupported_title();
    case "failed":
      return m.dataroom_failed_title();
    default:
      return m.dataroom_no_version_title();
  }
}

function unavailableBody(reason: DataRoomDocumentDetail["availability"]["reason"]): string {
  switch (reason) {
    case "processing":
      return m.dataroom_processing_body();
    case "unscanned":
      return m.dataroom_unscanned_body();
    case "infected":
      return m.dataroom_infected_body();
    case "unsupported":
      return m.dataroom_unsupported_body();
    case "failed":
      return m.dataroom_failed_body();
    default:
      return m.dataroom_no_version_body();
  }
}
