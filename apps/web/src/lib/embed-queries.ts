import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call, describeError, isApiError } from "./api.js";

/*
 * Queries, client-side origin rules and snippet generation for the embed kernel routes
 * (E2.2, EXECUTION_PLAN §9.3, ADR-0040).
 *
 * One read and one whole-object write. `frameAncestors`, `previewOriginPatterns` and the three
 * snippet URLs are derived server-side on every read and never stored, so invalidating
 * `["embed","settings"]` after the mutation is the whole cache story — there is nothing else
 * that could go stale, and nothing on this screen that the screen itself computes from data the
 * header does not see.
 */
export type EmbedSettings = FundRoomSchemas["EmbedSettings"];
export type EmbedHandoffKey = FundRoomSchemas["EmbedHandoffKey"];
export type EmbedHandoffKeyInput = FundRoomSchemas["EmbedHandoffKeyInput"];

export const EMBED_SETTINGS_KEY = ["embed", "settings"] as const;

export const embedSettingsQuery = queryOptions({
  queryKey: EMBED_SETTINGS_KEY,
  queryFn: () => call(api().GET("/embed/settings")),
});

/** `MAX_EMBED_ORIGINS` / `MAX_HANDOFF_KEYS` in `@fundroom/domain`; the server is the authority. */
export const MAX_EMBED_ORIGINS = 20;
export const MAX_HANDOFF_KEYS = 4;

/**
 * Why an origin was refused before it reached the network.
 *
 * The server refuses the same set (`normalizeEmbedOrigin` in `@fundroom/domain`, which is the
 * authority) and names the offending origin in `error.reason`; this mirror exists so the admin
 * finds out while the cursor is still in the field, and so the sentence can say *which* rule
 * they hit. "That is not a valid origin" for six different mistakes is how a field teaches
 * nobody anything.
 */
export const EMBED_ORIGIN_REASONS = [
  "empty",
  "wildcard",
  "not_an_origin",
  "insecure",
  "has_path",
  "has_credentials",
  "duplicate",
  "too_many",
] as const;
export type EmbedOriginReason = (typeof EMBED_ORIGIN_REASONS)[number];

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const EXACT_ORIGIN_RE = new RegExp(
  `^https://${HOST_LABEL}(?:\\.${HOST_LABEL})*(?::[1-9][0-9]{0,4})?$`,
  "u",
);
const LOCAL_ORIGIN_RE = new RegExp(
  `^http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|${HOST_LABEL}\\.localhost)(?::[1-9][0-9]{0,4})?$`,
  "u",
);

export type EmbedOriginCheck =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly reason: EmbedOriginReason };

/**
 * The client's copy of `normalizeEmbedOrigin`, with a reason attached.
 *
 * Deliberately not more permissive than the server anywhere: this only ever refuses earlier,
 * never accepts something the `PUT` would reject, so a list that passes here is a list the
 * server will store. `existing` catches the duplicate and the twenty-first entry, which the
 * server also refuses but which are worth saying before the round trip.
 */
export function checkEmbedOrigin(raw: string, existing: readonly string[] = []): EmbedOriginCheck {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  // Checked before parsing, because `new URL("https://*.acme.com")` succeeds: `*` is not a
  // forbidden host code point, so a wildcard would otherwise fail the host regex and be
  // reported as "not an origin" — true, and useless to someone who meant it.
  if (trimmed.includes("*")) return { ok: false, reason: "wildcard" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "not_an_origin" };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "has_credentials" };
  if (url.search !== "" || url.hash !== "") return { ok: false, reason: "has_path" };
  if (url.pathname !== "/" && url.pathname !== "") return { ok: false, reason: "has_path" };
  const origin = url.origin.toLowerCase();
  if (origin === "null") return { ok: false, reason: "not_an_origin" };
  if (!EXACT_ORIGIN_RE.test(origin) && !LOCAL_ORIGIN_RE.test(origin)) {
    return { ok: false, reason: url.protocol === "http:" ? "insecure" : "not_an_origin" };
  }
  if (existing.includes(origin)) return { ok: false, reason: "duplicate" };
  if (existing.length >= MAX_EMBED_ORIGINS) return { ok: false, reason: "too_many" };
  return { ok: true, origin };
}

/** One sentence per refusal — the reason the client bothers to mirror the rule at all. */
export function describeEmbedOriginReason(reason: EmbedOriginReason): string {
  switch (reason) {
    case "empty":
      return m.embed_origin_error_empty();
    case "wildcard":
      return m.embed_origin_error_wildcard();
    case "insecure":
      return m.embed_origin_error_insecure();
    case "has_path":
      return m.embed_origin_error_has_path();
    case "has_credentials":
      return m.embed_origin_error_has_credentials();
    case "duplicate":
      return m.embed_origin_error_duplicate();
    case "too_many":
      return m.embed_origin_error_too_many({ max: String(MAX_EMBED_ORIGINS) });
    default:
      return m.embed_origin_error_not_an_origin();
  }
}

/**
 * The server's own refusal, for the cases the mirror above cannot see (a list that grew in
 * another tab, a rule this build predates). `reason: "invalid_origin"` carries the origin.
 */
export function describeEmbedError(error: unknown): string {
  if (isApiError(error)) {
    const reason = error.body.error["reason"];
    const origin = error.body.error["origin"];
    if (reason === "invalid_origin" && typeof origin === "string") {
      return m.embed_origin_error_server({ origin });
    }
  }
  return describeError(error).body;
}

/** The Ed25519 public key a host generated: 32 bytes, base64url, unpadded. */
export const HANDOFF_PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/u;
/** JWS `kid`: short, host-chosen, opaque to us. */
export const HANDOFF_KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/*
 * Snippet generation.
 *
 * These strings live here rather than in the screen for two reasons: the components stay free of
 * literals, and there is exactly one place to keep in step with `docs/embed/quickstart.md`. That
 * document is the dialect — a second one invented on a settings screen would be the version
 * every customer actually pastes, and the docs would be describing something else.
 *
 * Only the three required options are emitted (`workspace`, `baseUrl`, `el`). The quickstart's
 * example adds `path: "/updates"`; a *generated* snippet must not, because it would open every
 * copied embed on a screen the workspace may not have. The optional options are in `api.md`.
 */
export interface EmbedSnippetInputs {
  readonly workspace: string;
  readonly baseUrl: string;
  readonly embedUrl: string;
  readonly loaderUrl: string;
  readonly loaderPinnedUrl: string;
  readonly loaderIntegrity: string;
}

/** The container id both the doc and the snippet use. */
const MOUNT_ID = "investors";

/**
 * Everything a snippet needs, from the one response that knows it.
 *
 * `workspace` and `baseUrl` are read back off `embedUrl` rather than taken from the boot config:
 * `embedUrl` is built on the workspace's *own* origin (its verified custom domain when it has
 * one), and a snippet whose `baseUrl` disagreed with its iframe `src` would put the loader on
 * one host and the frame on another — two entries in the host page's CSP, and two cookie jars.
 */
export function embedSnippetInputs(settings: EmbedSettings): EmbedSnippetInputs {
  const match = /^(.*)\/embed\/([^/?#]+)\/?$/u.exec(settings.embedUrl);
  return {
    workspace: match?.[2] ?? "",
    baseUrl: match?.[1] ?? "",
    embedUrl: settings.embedUrl,
    loaderUrl: settings.loaderUrl,
    loaderPinnedUrl: settings.loaderPinnedUrl,
    loaderIntegrity: settings.loaderIntegrity,
  };
}

function initCall(i: EmbedSnippetInputs): string {
  return `<script>
  SeedHost.init({
    workspace: "${i.workspace}",
    baseUrl: "${i.baseUrl}",
    el: "#${MOUNT_ID}",
  });
</script>`;
}

/** The rolling channel: fixes and new bridge messages without touching the snippet. */
export function loaderSnippet(i: EmbedSnippetInputs): string {
  return `<div id="${MOUNT_ID}"></div>

<script src="${i.loaderUrl}"></script>
${initCall(i)}`;
}

/**
 * The pinned channel with subresource integrity.
 *
 * SRI is only possible here: the hash is a promise that the bytes never change, and the rolling
 * `/embed/v1/` URL exists precisely so that they can. The cost is that the pinned URL freezes
 * its bugs too, so the quickstart tells a customer to pick it only when a review asks.
 */
export function pinnedLoaderSnippet(i: EmbedSnippetInputs): string {
  return `<div id="${MOUNT_ID}"></div>

<script
  src="${i.loaderPinnedUrl}"
  integrity="${i.loaderIntegrity}"
  crossorigin="anonymous"></script>
${initCall(i)}`;
}

/**
 * For hosts that allow an iframe but no script.
 *
 * `referrerpolicy` stays at `strict-origin-when-cross-origin` on purpose: a top-level iframe
 * navigation sends no `Origin` header, so `Referer` is the only thing the document's initiator
 * check has to look at. Suppressing it does not break rendering — it blinds the check, and
 * removes the only way an admin ever learns that someone else tried to frame their portal.
 */
export function iframeSnippet(i: EmbedSnippetInputs): string {
  return `<iframe
  src="${i.embedUrl}"
  title="Investor relations portal"
  style="width:100%;height:900px;border:0;display:block"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
  allow="clipboard-write; fullscreen; publickey-credentials-get"
  referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}
