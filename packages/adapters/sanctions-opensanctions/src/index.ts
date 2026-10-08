import {
  type SanctionsAdapterDeps,
  type SanctionsMatch,
  SanctionsProviderError,
  type SanctionsScreeningPort,
} from "@fundroom/ports";

/*
 * `@fundroom/sanctions-opensanctions` (E3.10, ADR-0058; owner: agent S). yente's
 * `POST /match/sanctions` (a self-hosted yente has no auth; the hosted API takes
 * `Authorization: ApiKey <key>`, sent only when a key is configured AND the base URL's host is
 * `api.opensanctions.org` or one of `apiKeyHosts` — a key never reaches a host nobody named for
 * it, e.g. a yente the URL was repointed to); `listVersion` from the
 * `sanctions` dataset's version in `GET /catalog`. OpenSanctions data is CC BY-NC: a managed host
 * needs a commercial data licence (doctor warns).
 *
 * The wire (vendors file §3.4): body `{"queries":{"q":{"schema":"Company","properties":{"name":
 * […],"country":[…]}}}}`, `threshold` as a query parameter; the answer is
 * `responses.q.results[]` with `id`, `caption`, `score` (0..1, a match confidence, not a risk
 * score), `match`, `datasets`. A result at or above the threshold is a potential match; `match`
 * alone (yente's own threshold) is not trusted over ours.
 *
 * Fail closed: a non-2xx, an answer of the wrong shape, a query-level error or a catalog without
 * the dataset throws `SanctionsProviderError`, never "clear". No redirects are followed (the
 * wiring's guarded client refuses them). Only the company's legal name and country are sent —
 * which is why a hosted API is a sub-processor and a self-hosted yente is not.
 */

export const OPENSANCTIONS_DATASET = "sanctions";
const HOSTED_API_HOST = "api.opensanctions.org";
/** How long a catalog answer is reused by `screen()`. */
const VERSION_TTL_MS = 10 * 60_000;
const MAX_RESULTS = 25;

export interface OpenSanctionsOptions {
  readonly dataset?: string | undefined;
  /** Hosts besides the hosted API the key may go to (SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS). */
  readonly apiKeyHosts?: readonly string[] | undefined;
}

function fail(message: string, cause?: unknown): SanctionsProviderError {
  return new SanctionsProviderError(message, cause === undefined ? undefined : { cause });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function createOpenSanctionsScreening(
  deps: SanctionsAdapterDeps,
  options: OpenSanctionsOptions = {},
): SanctionsScreeningPort {
  const dataset = options.dataset ?? OPENSANCTIONS_DATASET;
  const base = new URL(deps.baseUrl.endsWith("/") ? deps.baseUrl : `${deps.baseUrl}/`);
  const hosted = base.hostname.toLowerCase() === HOSTED_API_HOST;
  // Never over plain http (config refuses that too), and only to a host named for it.
  const keyAllowed =
    base.protocol === "https:" &&
    (hosted ||
      (options.apiKeyHosts ?? []).some(
        (h) => h.trim().toLowerCase() === base.hostname.toLowerCase(),
      ));
  const apiKey = keyAllowed ? deps.apiKey : undefined;
  let cached: { version: string; at: number } | undefined;

  function headers(json: boolean): Record<string, string> {
    return {
      accept: "application/json",
      ...(json ? { "content-type": "application/json" } : {}),
      ...(apiKey === undefined ? {} : { authorization: `ApiKey ${apiKey}` }),
    };
  }

  async function getJson(response: Response, what: string): Promise<unknown> {
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel().catch(() => {});
      throw fail(`${what}: HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch (cause) {
      throw fail(`${what}: not JSON`, cause);
    }
  }

  async function call(
    path: string,
    init: RequestInit,
    what: string,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await deps.fetch(new URL(path, base), {
        ...init,
        redirect: "manual",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      throw fail(`${what}: request failed`, cause);
    }
    return getJson(response, what);
  }

  async function version(signal: AbortSignal | undefined): Promise<string> {
    const body = await call(
      "catalog",
      { method: "GET", headers: headers(false) },
      "catalog",
      signal,
    );
    const datasets = isRecord(body) && Array.isArray(body["datasets"]) ? body["datasets"] : null;
    if (datasets === null) throw fail("catalog: no datasets");
    const entry = datasets.find((d) => isRecord(d) && d["name"] === dataset);
    const v = isRecord(entry) ? entry["version"] : undefined;
    if (typeof v !== "string" || !/^[\w.:-]{1,100}$/u.test(v)) {
      throw fail(`catalog: dataset ${dataset} has no version`);
    }
    const out = `opensanctions:${dataset}:${v}`;
    cached = { version: out, at: deps.now().getTime() };
    return out;
  }

  async function currentVersion(signal: AbortSignal | undefined): Promise<string> {
    if (cached !== undefined && deps.now().getTime() - cached.at <= VERSION_TTL_MS) {
      return cached.version;
    }
    return version(signal);
  }

  return {
    driver: "opensanctions",
    meta: {
      subProcessor: hosted
        ? {
            name: "OpenSanctions",
            purpose: "Sanctions screening of customer companies (legal name and country)",
            location: "EU (Germany)",
            url: "https://www.opensanctions.org/",
            jurisdiction: "eu",
          }
        : null,
      lists: [`OpenSanctions \`${dataset}\` collection`],
    },

    async screen(subject, opts) {
      const listVersion = await currentVersion(opts.signal);
      const properties: Record<string, string[]> = { name: [subject.name] };
      if (subject.country !== null) properties["country"] = [subject.country.toLowerCase()];
      const query = new URLSearchParams({
        threshold: String(opts.threshold),
        limit: String(MAX_RESULTS),
      });
      const body = await call(
        `match/${encodeURIComponent(dataset)}?${query.toString()}`,
        {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({
            queries: {
              q: {
                schema: subject.kind === "person" ? "Person" : "Company",
                properties,
              },
            },
          }),
        },
        "match",
        opts.signal,
      );
      const responses = isRecord(body) ? body["responses"] : undefined;
      const q = isRecord(responses) ? responses["q"] : undefined;
      if (!isRecord(q)) throw fail("match: no response for the query");
      if (q["status"] !== undefined && q["status"] !== 200) {
        throw fail(`match: query status ${String(q["status"])}`);
      }
      const results = q["results"];
      if (!Array.isArray(results)) throw fail("match: no results array");
      const matches: SanctionsMatch[] = [];
      for (const r of results) {
        if (!isRecord(r) || typeof r["id"] !== "string" || typeof r["score"] !== "number") {
          throw fail("match: a result without id or score");
        }
        const score = r["score"];
        if (!Number.isFinite(score) || score < 0 || score > 1)
          throw fail("match: score out of range");
        if (score < opts.threshold) continue;
        const caption = typeof r["caption"] === "string" ? r["caption"] : r["id"];
        matches.push({
          listEntryId: r["id"],
          name: caption,
          score: Math.round(score * 1000) / 1000,
          programs: strings(r["datasets"]),
          source: "OpenSanctions",
        });
      }
      matches.sort((a, b) => b.score - a.score);
      return {
        outcome: matches.length > 0 ? "potential_match" : "clear",
        listVersion,
        matches,
      };
    },

    async listVersion(opts) {
      return version(opts?.signal);
    },
  };
}
