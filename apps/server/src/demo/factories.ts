/*
 * Synthetic data for `fundroom seed-demo` (design/07 §7). Deterministic: the same seed
 * always yields the same people, so demos, screenshots and e2e fixtures stay stable across
 * runs and machines. No faker dependency on purpose: the generator ships inside the
 * production image, and a few word lists are all a kernel-only demo needs (documents,
 * updates and KPIs arrive with their modules in Phase 1).
 *
 * Every address uses a reserved domain (RFC 2606 / RFC 6761): nothing here can ever
 * reach a real mailbox, and `factories.test.ts` enforces it.
 */
export const DEMO_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "investors.test",
] as const;

export function isDemoDomain(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return DEMO_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

const FIRST = [
  "Ada",
  "Grace",
  "Linus",
  "Mira",
  "Tomás",
  "Yuki",
  "Femi",
  "Noor",
  "Ravi",
  "Sven",
  "Ines",
  "Kai",
  "Zoë",
  "Omar",
  "Lea",
  "Jonas",
] as const;
const LAST = [
  "Lovelace",
  "Hopper",
  "Okafor",
  "Sato",
  "Haddad",
  "Novak",
  "Fischer",
  "Mendes",
  "Iyer",
  "Berg",
  "Costa",
  "Lind",
] as const;
const FIRMS = [
  "Northwind Capital",
  "Harbor Angels",
  "Blue Fjord Ventures",
  "Seedling Partners",
  "Meridian Growth",
] as const;

export const INVESTOR_TIERS = ["board", "lead", "fund", "angel"] as const;
export type InvestorTier = (typeof INVESTOR_TIERS)[number];

export interface DemoPerson {
  readonly email: string;
  readonly displayName: string;
}

export interface DemoInvestor extends DemoPerson {
  readonly tier: InvestorTier;
  /** A firm for funds and leads; angels invest personally. */
  readonly firm: string | undefined;
  /** Every fourth investor is still only invited (has not signed in yet). */
  readonly invited: boolean;
}

/** mulberry32: tiny, seedable, good enough for names. */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  const item = list[Math.floor(random() * list.length)];
  if (item === undefined) throw new Error("empty list");
  return item;
}

function localPart(first: string, last: string): string {
  return `${first}.${last}`
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]/gu, "");
}

export interface DemoPeople {
  readonly owner: DemoPerson;
  readonly staff: readonly (DemoPerson & { readonly role: "admin" | "editor" })[];
  readonly investors: readonly DemoInvestor[];
}

export interface DemoPeopleOptions {
  readonly seed?: number | undefined;
  readonly investors?: number | undefined;
  readonly ownerEmail?: string | undefined;
}

/** The cast of one demo workspace: an owner, two staff, `investors` investors across tiers. */
export function demoPeople(options: DemoPeopleOptions = {}): DemoPeople {
  const random = createRandom(options.seed ?? 0x5eed);
  const count = Math.max(1, Math.min(200, options.investors ?? 12));
  const used = new Set<string>();
  const unique = (make: () => string): string => {
    for (let i = 0; i < 1000; i += 1) {
      const candidate = make();
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    throw new Error("could not generate a unique address");
  };
  const person = (domain: string): DemoPerson => {
    const first = pick(random, FIRST);
    const last = pick(random, LAST);
    const email = unique(() => `${localPart(first, last)}${used.size}@${domain}`);
    return { email, displayName: `${first} ${last}` };
  };
  const ownerEmail = options.ownerEmail ?? "founder@example.com";
  if (!isDemoDomain(ownerEmail))
    throw new Error(`owner email must use a reserved demo domain: ${DEMO_DOMAINS.join(", ")}`);
  used.add(ownerEmail);
  const owner: DemoPerson = { email: ownerEmail, displayName: "Sam Founder" };
  const staff = [
    { ...person("example.com"), role: "admin" as const },
    { ...person("example.com"), role: "editor" as const },
  ];
  const investors: DemoInvestor[] = [];
  for (let i = 0; i < count; i += 1) {
    const tier = INVESTOR_TIERS[i % INVESTOR_TIERS.length] ?? "angel";
    const domain = tier === "angel" ? "example.org" : "investors.test";
    investors.push({
      ...person(domain),
      tier,
      firm: tier === "angel" ? undefined : pick(random, FIRMS),
      invited: i % 4 === 3,
    });
  }
  return { owner, staff, investors };
}
