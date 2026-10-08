import type { DnsAnswer, DnsRecordType, DnsResolverPort, OutboundFetch } from "@fundroom/ports";

/*
 * DNS-over-HTTPS, JSON flavour (design/07 §2.2 step 3: "DoH to 1.1.1.1/8.8.8.8 to dodge
 * local resolver caching").
 *
 * Two properties are the reason this adapter exists rather than `node:dns`:
 *
 *  - **No system resolver.** The endpoints are IP literals, so nothing in `/etc/resolv.conf`,
 *    no container DNS, no split-horizon corporate view and no `/etc/hosts` entry sits between
 *    us and the customer's zone. A self-hoster whose LAN resolver answers for the customer's
 *    domain cannot make us verify a hostname it does not control.
 *  - **Quorum.** A positive answer needs two independent resolvers to agree (E2.1 decision 7).
 *    One poisoned or hijacked resolver can then only *withhold* a verification, never grant
 *    one — which is the right direction for the failure to point.
 */

/** Cloudflare and Google, by address, both speaking the `application/dns-json` API. */
export const DEFAULT_DOH_ENDPOINTS: readonly string[] = [
  "https://1.1.1.1/dns-query",
  "https://8.8.8.8/resolve",
];

export interface DohResolverOptions {
  /** DoH JSON endpoints, in order. Default: Cloudflare then Google. */
  readonly endpoints?: readonly string[] | undefined;
  /** Must be the SSRF-guarded fetch. */
  readonly fetch: OutboundFetch;
  /** How many endpoints must agree for a non-empty answer. Default 2. */
  readonly quorum?: number | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

const DEFAULT_QUORUM = 2;

/** RFC 1035 / 3596 type numbers, which is how the JSON API labels records. */
const TYPE_NUMBERS: Readonly<Record<DnsRecordType, number>> = {
  A: 1,
  AAAA: 28,
  CNAME: 5,
  TXT: 16,
};
const CNAME_TYPE = 5;

type Rcode = DnsAnswer["rcode"];

/** Status is the DNS RCODE (RFC 1035 §4.1.1) verbatim. */
function rcodeOf(status: unknown): Rcode {
  switch (status) {
    case 0:
      return "ok";
    case 2:
      return "servfail";
    case 3:
      return "nxdomain";
    case 5:
      return "refused";
    default:
      return "other";
  }
}

function stripRoot(value: string): string {
  const lower = value.trim().toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * A TXT record's `data` is the presentation form: one or more quoted strings, split at 255
 * octets by the wire format. Rejoining them is what `DnsAnswer.values` promises ("joined TXT
 * strings"), and the quotes are dropped because they are framing, not content.
 */
function joinTxt(data: string): string {
  const chunks = data.match(/"(?:\\.|[^"\\])*"/gu);
  if (chunks === null) return stripRoot(data);
  return chunks
    .map((chunk) => chunk.slice(1, -1).replace(/\\(.)/gu, "$1"))
    .join("")
    .toLowerCase();
}

interface DohRecord {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly data?: unknown;
}

interface DohBody {
  readonly Status?: unknown;
  readonly Answer?: unknown;
}

function records(body: DohBody): readonly DohRecord[] {
  return Array.isArray(body.Answer) ? (body.Answer as readonly DohRecord[]) : [];
}

function endpointUrl(endpoint: string, name: string, type: DnsRecordType): string {
  const url = new URL(endpoint);
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  return url.toString();
}

/** A stable, log-safe name for an endpoint: the host, which is the IP literal. */
function resolverName(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * The owner names an answer record is allowed to carry — the bailiwick check (E2.1 M11).
 *
 * A resolver's `Answer` array is data from somebody else's zone relayed by a third party, and
 * nothing in the JSON API stops it carrying a record for a name we never asked about. Accepting
 * one would let a resolver (or anything that can rewrite its response) satisfy a challenge with a
 * record published on a hostname it *does* control. So the only acceptable owner names are the
 * query name and whatever the CNAME chain leads to from it.
 *
 * The chain is followed to a fixpoint rather than in array order: the records are short, and the
 * JSON API does not promise the chain arrives outermost-first.
 */
function bailiwick(answers: readonly DohRecord[], name: string): ReadonlySet<string> {
  const allowed = new Set([stripRoot(name)]);
  for (let pass = 0; pass < answers.length + 1; pass++) {
    let grew = false;
    for (const record of answers) {
      if (record.type !== CNAME_TYPE) continue;
      if (typeof record.name !== "string" || typeof record.data !== "string") continue;
      if (!allowed.has(stripRoot(record.name))) continue;
      const target = stripRoot(record.data);
      if (allowed.has(target)) continue;
      allowed.add(target);
      grew = true;
    }
    if (!grew) break;
  }
  return allowed;
}

async function queryOne(
  options: DohResolverOptions,
  endpoint: string,
  name: string,
  type: DnsRecordType,
): Promise<DnsAnswer | undefined> {
  const resolver = resolverName(endpoint);
  try {
    const response = await options.fetch(endpointUrl(endpoint, name, type), {
      method: "GET",
      headers: { accept: "application/dns-json" },
    });
    if (!response.ok) {
      options.log?.("dns.doh.http_error", { resolver, name, type, status: response.status });
      return undefined;
    }
    const body = (await response.json()) as DohBody;
    const answers = records(body);
    const wanted = TYPE_NUMBERS[type];
    const allowed = bailiwick(answers, name);
    const values: string[] = [];
    const chain: string[] = [];
    for (const record of answers) {
      if (typeof record.data !== "string") continue;
      // Out of bailiwick: a record for a name that is neither the question nor anywhere the
      // question's CNAME chain leads. Dropped, and said so, because silently ignoring it would
      // hide a resolver behaving badly.
      if (typeof record.name !== "string" || !allowed.has(stripRoot(record.name))) {
        options.log?.("dns.doh.out_of_bailiwick", {
          level: "warn",
          resolver,
          name,
          type,
          owner: typeof record.name === "string" ? stripRoot(record.name) : null,
        });
        continue;
      }
      if (record.type === CNAME_TYPE) chain.push(stripRoot(record.data));
      if (record.type !== wanted) continue;
      values.push(type === "TXT" ? joinTxt(record.data) : stripRoot(record.data));
    }
    return {
      name: stripRoot(name),
      type,
      values,
      rcode: rcodeOf(body.Status),
      resolver,
      chain: chain.length > 0 ? chain : undefined,
    };
  } catch (error) {
    // A transport failure is an answer of `other`, never an exception: the verify job must be
    // able to record "we could not tell" without the whole sweep unwinding.
    options.log?.("dns.doh.unreachable", {
      resolver,
      name,
      type,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Identity of an answer's value *set*: order and duplicates from a round-robin zone must
 *  not count as disagreement. */
function valueKey(answer: DnsAnswer): string {
  return [...new Set(answer.values)].sort().join("\u0000");
}

function unusable(name: string, type: DnsRecordType, resolver: string): DnsAnswer {
  return { name: stripRoot(name), type, values: [], rcode: "other", resolver, chain: undefined };
}

/**
 * Reduce the per-endpoint answers to the one we act on.
 *
 * The asymmetry is deliberate. A *positive* answer is a licence to issue a certificate for
 * somebody else's hostname, so it needs `quorum` **distinct resolvers** agreeing on the same
 * value set. A *negative* answer costs nothing but a retry in five minutes, so a single one is
 * enough, and disagreement collapses to the negative. There is no path here from "the resolvers
 * differ" to "verified".
 *
 * Distinct *identity*, not answer count (E2.1 S4). Counting answers made quorum 2 satisfiable by
 * one resolver asked twice — `DOH_ENDPOINTS=https://1.1.1.1/dns-query,https://1.1.1.1/dns-query`
 * passed both the config rule and the quorum, and decision 6's guarantee was gone with nothing
 * on screen to say so. The adapter also dedupes its endpoint list by host, so the two halves
 * cannot drift; this is the half that holds even if a caller hands in its own answers.
 */
function reduceAnswers(
  answers: readonly DnsAnswer[],
  quorum: number,
  name: string,
  type: DnsRecordType,
  log: DohResolverOptions["log"],
): DnsAnswer {
  if (answers.length === 0) return unusable(name, type, "none");
  const distinct = (group: readonly DnsAnswer[]): number =>
    new Set(group.map((answer) => answer.resolver)).size;

  const positives = answers.filter((answer) => answer.values.length > 0);
  const groups = new Map<string, DnsAnswer[]>();
  for (const answer of positives) {
    const key = valueKey(answer);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [answer]);
    else group.push(answer);
  }

  for (const group of groups.values()) {
    const first = group[0];
    if (first !== undefined && distinct(group) >= quorum) {
      const resolvers = [...new Set(group.map((answer) => answer.resolver))];
      return resolvers.length === distinct(answers)
        ? first
        : { ...first, resolver: resolvers.join("+") };
    }
  }

  const negative = answers.find((answer) => answer.values.length === 0);
  if (positives.length === 0) {
    // Every resolver that answered says the record is not there. `negative` is defined here
    // by construction, but narrow it properly rather than asserting.
    return negative ?? unusable(name, type, "none");
  }

  log?.("dns.doh.no_quorum", {
    name,
    type,
    quorum,
    answers: answers.map((answer) => ({ resolver: answer.resolver, values: answer.values })),
  });
  // Someone saw a value, nobody has a quorum for it. Report the weaker answer: a real
  // negative if we have one, otherwise a synthetic `other` that `evaluate` renders as
  // "the resolvers disagreed" — never the value that missed quorum.
  return negative ?? unusable(name, type, answers.map((answer) => answer.resolver).join("+"));
}

/**
 * One endpoint per host (E2.1 S4).
 *
 * `DOH_ENDPOINTS=https://1.1.1.1/dns-query,https://1.1.1.1/dns-query` is two entries and one
 * resolver: it used to pass the config rule (which only counted entries) and then satisfy a
 * quorum of two from a single cache, silently downgrading decision 6. Deduping here means the
 * quorum is clamped to the number of resolvers that actually exist, so the clamp warning fires
 * and the operator sees what they configured.
 *
 * The residual is honest and stated in ADR-0039: two *distinct* hosts can still be one operator
 * and one cache (`1.1.1.1` and `1.0.0.1` are both Cloudflare). No amount of string comparison
 * knows that; identical hosts are the part that can be known, so that is the part enforced.
 */
function dedupeByHost(endpoints: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const endpoint of endpoints) {
    const host = resolverName(endpoint);
    if (seen.has(host)) continue;
    seen.add(host);
    kept.push(endpoint);
  }
  return kept;
}

export function createDohResolver(options: DohResolverOptions): DnsResolverPort {
  const configured =
    options.endpoints !== undefined && options.endpoints.length > 0
      ? options.endpoints
      : DEFAULT_DOH_ENDPOINTS;
  const endpoints = dedupeByHost(configured);
  if (endpoints.length < configured.length) {
    options.log?.("dns.doh.endpoints_deduped", {
      level: "warn",
      configured: configured.length,
      resolvers: endpoints.length,
    });
  }
  const requested = options.quorum ?? DEFAULT_QUORUM;
  // An operator who configures one endpoint and leaves quorum at 2 would otherwise be unable
  // to verify anything, which reads as a broken feature rather than a policy. Clamp, and say
  // so loudly — at one endpoint the decision-7 guarantee is gone.
  const quorum = Math.max(1, Math.min(requested, endpoints.length));
  if (quorum < requested) {
    options.log?.("dns.doh.quorum_clamped", {
      requested,
      quorum,
      endpoints: endpoints.length,
    });
  }

  return {
    driver: "doh",

    async resolve(name, type) {
      const answers = (
        await Promise.all(endpoints.map((endpoint) => queryOne(options, endpoint, name, type)))
      ).filter((answer): answer is DnsAnswer => answer !== undefined);
      return reduceAnswers(answers, quorum, name, type, options.log);
    },

    /**
     * Probes every endpoint directly, bypassing quorum: `/readyz` should be red only when no
     * resolver is reachable at all, not when two healthy resolvers happen to disagree about
     * a round-robin address.
     */
    async healthCheck() {
      const answers = await Promise.all(
        endpoints.map((endpoint) => queryOne(options, endpoint, "example.com", "A")),
      );
      if (answers.every((answer) => answer === undefined)) {
        throw new Error(`no DoH endpoint answered (${endpoints.map(resolverName).join(", ")})`);
      }
    },
  };
}
