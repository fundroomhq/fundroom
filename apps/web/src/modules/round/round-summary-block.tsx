import type { Allocation, Terms } from "@fundroom/round-terms";
import { INSTRUMENT_KINDS, parseTerms } from "@fundroom/round-terms";
import { Scale } from "lucide-react";
import { Markdown } from "../../lib/markdown.js";
import type { RoundDisclaimer } from "../../lib/round-queries.js";
import { m } from "../../paraglide/messages.js";
import { StatusBar } from "./status-bar.js";
import { type InstrumentSummary, InstrumentSummaryCard } from "./terms.js";

/*
 * The `round_summary` content block (contract §R). A **reference** block: the page stores an
 * empty config and the round module hydrates it after visibility, so what arrives here is a
 * viewer-safe payload that has already had `showProgress` and the offering rules applied.
 *
 * Two silences are deliberate:
 *
 *  - **an anonymous viewer hydrates to `{}`**, and `{}` renders as nothing. A 506(b) offering
 *    must never carry terms into a public section (plan principle 1), and the hydrator refuses
 *    the block there outright — so an empty payload is the *expected* case on a public page,
 *    not an error, and a "sign in to see the round" placeholder would be the disclosure the
 *    refusal exists to prevent.
 *  - **a malformed payload renders nothing too.** Like every other block renderer here, the
 *    shape is validated rather than trusted: a newer server must never break an older client,
 *    and half a term sheet is worse than none.
 */

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function readRound(v: unknown): InstrumentSummary | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const name = str(o["name"]);
  const currency = str(o["currency"]);
  const targetAmount = str(o["targetAmount"]);
  const stage = str(o["stage"]);
  const instrumentKind = str(o["instrumentKind"]);
  if (name === null || currency === null || targetAmount === null) return null;
  if (stage === null || instrumentKind === null) return null;
  return {
    name,
    stage,
    instrumentKind,
    currency,
    targetAmount,
    minimumInvestment: str(o["minimumInvestment"]),
  };
}

function readTerms(v: unknown, instrumentKind: string): Terms | null {
  if (typeof v !== "object" || v === null) return null;
  if (!INSTRUMENT_KINDS.includes(instrumentKind as never)) return null;
  try {
    // The shared schema is the validator: a second hand-written one here would be a second
    // definition of what a SAFE is, and the two would drift.
    return parseTerms(instrumentKind as (typeof INSTRUMENT_KINDS)[number], v);
  } catch {
    return null;
  }
}

function readProgress(v: unknown): Allocation | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const amounts = [
    "target",
    "soft",
    "verbal",
    "signed",
    "wired",
    "committed",
    "total",
    "remaining",
  ];
  const out: Record<string, unknown> = {};
  for (const key of amounts) {
    const value = str(o[key]);
    if (value === null) return null;
    out[key] = value;
  }
  const percent = o["percent"];
  if (typeof percent !== "object" || percent === null) return null;
  const p = percent as Record<string, unknown>;
  const soft = str(p["soft"]);
  const committed = str(p["committed"]);
  const wired = str(p["wired"]);
  if (soft === null || committed === null || wired === null) return null;
  out["percent"] = { soft, committed, wired };
  return out as unknown as Allocation;
}

function readDisclaimer(v: unknown): RoundDisclaimer | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const title = str(o["title"]);
  const body = str(o["body"]);
  if (title === null || body === null) return null;
  return {
    stamp: str(o["stamp"]) ?? "",
    title,
    body,
    versionNo: typeof o["versionNo"] === "number" ? o["versionNo"] : null,
  };
}

export interface RoundSummaryPayload {
  readonly round: InstrumentSummary;
  readonly terms: Terms | null;
  readonly progress: Allocation | null;
  readonly disclaimer: RoundDisclaimer | null;
}

export function readRoundSummary(hydrated: unknown): RoundSummaryPayload | null {
  if (typeof hydrated !== "object" || hydrated === null) return null;
  const o = hydrated as Record<string, unknown>;
  const round = readRound(o["round"]);
  if (round === null) return null;
  return {
    round,
    terms: readTerms(o["terms"], round.instrumentKind),
    progress: readProgress(o["progress"]),
    disclaimer: readDisclaimer(o["disclaimer"]),
  };
}

export function RoundSummaryBlock({ hydrated }: { hydrated: unknown }) {
  const payload = readRoundSummary(hydrated);
  if (payload === null) return null;
  return (
    <div className="space-y-4">
      <InstrumentSummaryCard round={payload.round} terms={payload.terms}>
        {payload.progress === null ? null : (
          <StatusBar allocation={payload.progress} currency={payload.round.currency} />
        )}
      </InstrumentSummaryCard>
      {payload.disclaimer === null ? null : (
        <aside
          aria-label={payload.disclaimer.title}
          className="rounded-lg border-l-4 border-muted-foreground/30 bg-muted/40 p-4 text-sm text-muted-foreground"
        >
          <p className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <Scale aria-hidden="true" className="size-3.5" />
            {payload.disclaimer.versionNo === null
              ? payload.disclaimer.title
              : m.round_disclaimer_version({
                  title: payload.disclaimer.title,
                  version: String(payload.disclaimer.versionNo),
                })}
          </p>
          <Markdown
            source={payload.disclaimer.body}
            className="prose prose-sm prose-neutral max-w-prose dark:prose-invert"
          />
        </aside>
      )}
    </div>
  );
}
