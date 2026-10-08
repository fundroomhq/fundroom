import { generateKeyPairSync } from "node:crypto";
import { decryptBytes, encryptBytes } from "@fundroom/crypto";
import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import type { DnsResolverPort } from "@fundroom/ports";
import { type Actor, UpdatesError } from "../errors.js";
import { SendingDomainRepo } from "../repos/updates-repo.js";
import type { SendingDomain } from "../schema/updates.js";

/*
 * Per-workspace sending domain (E1.4 "sending domain records UI"; E2.1 owns the custom
 * web domain). The workspace generates an RSA-2048 DKIM key pair here; the private key is
 * envelope-encrypted under the workspace DEK (ADR-0016) and only ever unwrapped to sign an
 * outgoing update. Verification reads DNS: DKIM must match, SPF and DMARC are advisory
 * (the SPF include depends on the operator's SMTP provider, which we do not know).
 *
 * The lookups go through `services.dns` — the shared DoH resolver (E2.1 decision 2) — not
 * `node:dns`. Two reasons: design/07 asks for DoH to public resolvers so a stale negative in the
 * local resolver's cache cannot read to a founder as "your DNS is wrong" when it is not, and
 * a module-level mutable global (which is what the old test seam was) cannot be injected per
 * tenant. Tests now hand in a fake `DnsResolverPort` instead of mutating a module variable.
 */

export const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export interface DnsRecord {
  readonly kind: "dkim" | "spf" | "dmarc";
  readonly type: "TXT";
  readonly name: string;
  readonly value: string;
  readonly required: boolean;
}

export interface DomainCheck {
  readonly ok: boolean;
  readonly found: string | null;
}
export interface DomainChecks {
  readonly dkim?: DomainCheck | undefined;
  readonly spf?: DomainCheck | undefined;
  readonly dmarc?: DomainCheck | undefined;
}

export interface SendingDomainView {
  readonly id: string;
  readonly domain: string;
  readonly selector: string;
  readonly status: SendingDomain["status"];
  readonly records: readonly DnsRecord[];
  readonly checks: DomainChecks;
  readonly lastCheckedAt: Date | null;
  readonly lastError: string | null;
  readonly verifiedAt: Date | null;
  readonly createdAt: Date;
}

export interface DkimSigner {
  readonly domainName: string;
  readonly keySelector: string;
  readonly privateKey: string;
}

interface Encryption {
  readonly format: "she1";
  readonly keyId: string;
  readonly keyRef: string;
}

function dkimValue(publicKeyPem: string): string {
  const p = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/u, "")
    .replace(/-----END PUBLIC KEY-----/u, "")
    .replace(/\s+/gu, "");
  return `v=DKIM1; k=rsa; p=${p}`;
}

export function recordsFor(
  d: Pick<SendingDomain, "domain" | "selector" | "publicKey">,
): DnsRecord[] {
  return [
    {
      kind: "dkim",
      type: "TXT",
      name: `${d.selector}._domainkey.${d.domain}`,
      value: dkimValue(d.publicKey),
      required: true,
    },
    {
      kind: "spf",
      type: "TXT",
      name: d.domain,
      value: "v=spf1 include:<your SMTP provider> ~all",
      required: false,
    },
    {
      kind: "dmarc",
      type: "TXT",
      name: `_dmarc.${d.domain}`,
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${d.domain}`,
      required: false,
    },
  ];
}

/**
 * The TXT strings published at `name`, or none.
 *
 * The port already joins the 255-octet chunks of a TXT record and never throws for a
 * DNS-level problem, so the mapping is about which rcodes mean "no records". `nxdomain` (the
 * name does not exist) and an `ok` with an empty answer (the name exists with no TXT) are
 * both "nothing published yet" — exactly what E1.4's `ENOTFOUND` / `ENODATA` branch meant, and
 * the verification stays `pending` so the admin can publish and click again.
 *
 * Everything else — `servfail`, `refused`, a transport failure, or the resolvers failing to
 * reach quorum — is *not* a negative answer, it is no answer. Throwing here is how `verify()`
 * learns to record `last_error` rather than telling the admin their records are missing when we
 * simply could not look — and, since E2.1 S5, how it learns **not to demote a domain that is
 * already verified**: under `node:dns` a single successful answer sufficed, while the DoH adapter
 * reports `other` whenever only one endpoint answers, so a routine one-provider blip reaches here
 * far more often than `ENOTFOUND` ever did.
 */
export async function lookupTxt(dns: DnsResolverPort, name: string): Promise<readonly string[]> {
  const answer = await dns.resolve(name, "TXT");
  if (answer.rcode === "ok" || answer.rcode === "nxdomain") return answer.values;
  throw new Error(`DNS lookup for ${name} failed: ${answer.rcode} (${answer.resolver})`);
}

/** Compares DKIM records ignoring whitespace and quoting differences. */
export function dkimMatches(found: string, expected: string): boolean {
  const norm = (s: string) => s.replace(/["\s]/gu, "").toLowerCase();
  const pOf = (s: string) => /p=([a-z0-9+/=]+)/iu.exec(norm(s))?.[1] ?? "";
  return pOf(found) !== "" && pOf(found) === pOf(expected);
}

export function createSendingDomainService(services: ModuleServices) {
  const { db, crypto, dns } = services;
  const now = () => services.now();

  function view(d: SendingDomain): SendingDomainView {
    return {
      id: d.id,
      domain: d.domain,
      selector: d.selector,
      status: d.status,
      records: recordsFor(d),
      checks: (d.checks ?? {}) as DomainChecks,
      lastCheckedAt: d.lastCheckedAt,
      lastError: d.lastError,
      verifiedAt: d.verifiedAt,
      createdAt: d.createdAt,
    };
  }

  return {
    async get(ctx: TenantContext): Promise<SendingDomainView | null> {
      const d = await db.withTenant(ctx, (tx) => new SendingDomainRepo(ctx, tx).current());
      return d ? view(d) : null;
    },

    /** Replaces the workspace's sending domain with a fresh key pair. */
    async set(ctx: TenantContext, domain: string, actor: Actor): Promise<SendingDomainView> {
      const name = domain.trim().toLowerCase();
      if (!DOMAIN_RE.test(name)) throw new UpdatesError("validation_failed", "not a domain name");
      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      const selector = `sh${now().toISOString().slice(0, 7).replace("-", "")}${Math.random().toString(36).slice(2, 6)}`;
      return db.withTenant(ctx, async (tx) => {
        const repo = new SendingDomainRepo(ctx, tx);
        const existing = await repo.current();
        if (existing) {
          await repo.remove(existing.id);
          await services.audit.record(tx, ctx, {
            action: "sending_domain.deleted",
            resourceKind: "sending_domain",
            resourceId: existing.id,
            actorMembershipId: actor.membershipId,
            requestId: actor.requestId,
            meta: { replaced: true },
          });
        }
        const dek = await crypto.currentKey(tx, ctx);
        const enc = await encryptBytes(dek.key, Buffer.from(privateKey, "utf8"));
        const encryption: Encryption = { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef };
        const d = await repo.create({
          domain: name,
          selector,
          publicKey,
          privateKeyEnc: enc,
          encryption,
          createdBy: actor.membershipId,
        });
        await services.audit.record(tx, ctx, {
          action: "sending_domain.created",
          resourceKind: "sending_domain",
          resourceId: d.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          meta: { selector },
        });
        return view(d);
      });
    },

    async verify(ctx: TenantContext, actor: Actor): Promise<SendingDomainView> {
      const d = await db.withTenant(ctx, (tx) => new SendingDomainRepo(ctx, tx).current());
      if (!d) throw new UpdatesError("not_found", "no sending domain");
      const records = recordsFor(d);
      const checks: { dkim: DomainCheck; spf: DomainCheck; dmarc: DomainCheck } = {
        dkim: { ok: false, found: null },
        spf: { ok: false, found: null },
        dmarc: { ok: false, found: null },
      };
      let error: string | null = null;
      try {
        for (const r of records) {
          const found = await lookupTxt(dns, r.name);
          const hit =
            r.kind === "dkim"
              ? found.find((f) => dkimMatches(f, r.value))
              : r.kind === "spf"
                ? found.find((f) => /^v=spf1\b/iu.test(f.trim()))
                : found.find((f) => /^v=dmarc1\b/iu.test(f.trim()));
          checks[r.kind] = { ok: hit !== undefined, found: hit ?? found[0] ?? null };
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const verified = error === null && checks.dkim.ok;
      /*
       * A lookup failure must not unverify a working sending domain (E2.1 S5).
       *
       * `lookupTxt` throws for anything that is not `ok`/`nxdomain`, and the DoH adapter reports
       * `other` whenever only one of the two endpoints answers — so a routine single-provider
       * blip used to produce `status: "failed"` **and `verifiedAt: null`**, and `signer()` gates
       * on `status === "verified"`, which meant outgoing updates silently stopped being
       * DKIM-signed until an admin happened to click verify again. "We could not look" is not
       * evidence that the records are gone, so a verified domain keeps its status, its
       * `verifiedAt` and its `checks` (overwriting those with the empty ones this pass collected
       * would show a red DKIM row beside a green status), and the failure is recorded in
       * `lastError` / `lastCheckedAt` where an admin and an operator can both see it.
       *
       * Everything else is E1.4 unchanged: DKIM required, SPF/DMARC advisory, and `nxdomain` or
       * an empty answer means "nothing published yet" → `pending`, not `failed`.
       */
      const keepVerified = error !== null && d.status === "verified";
      const t = now();
      return db.withTenant(ctx, async (tx) => {
        const repo = new SendingDomainRepo(ctx, tx);
        const updated = await repo.update(d.id, {
          status: verified || keepVerified ? "verified" : error ? "failed" : "pending",
          checks: keepVerified ? ((d.checks ?? checks) as typeof checks) : checks,
          lastCheckedAt: t,
          lastError: error,
          verifiedAt: verified || keepVerified ? (d.verifiedAt ?? t) : null,
        });
        if (updated === undefined) throw new UpdatesError("not_found", "no sending domain");
        if (verified && d.status !== "verified") {
          await services.audit.record(tx, ctx, {
            action: "sending_domain.verified",
            resourceKind: "sending_domain",
            resourceId: d.id,
            actorMembershipId: actor.membershipId,
            requestId: actor.requestId,
            meta: { dkim: true, spf: checks.spf.ok, dmarc: checks.dmarc.ok },
          });
        }
        return view(updated);
      });
    },

    async remove(ctx: TenantContext, actor: Actor): Promise<void> {
      await db.withTenant(ctx, async (tx) => {
        const repo = new SendingDomainRepo(ctx, tx);
        const d = await repo.current();
        if (!d) throw new UpdatesError("not_found", "no sending domain");
        await repo.remove(d.id);
        await services.audit.record(tx, ctx, {
          action: "sending_domain.deleted",
          resourceKind: "sending_domain",
          resourceId: d.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
        });
      });
    },

    /** The verified domain's signer (private key unwrapped in memory), or undefined. */
    async signer(
      tx: Tx,
      ctx: TenantContext,
    ): Promise<{ domain: string; dkim: DkimSigner } | undefined> {
      const d = await new SendingDomainRepo(ctx, tx).current();
      if (d?.status !== "verified") return undefined;
      const enc = d.encryption as Partial<Encryption>;
      if (enc.keyId === undefined) return undefined;
      const key = await crypto.keyById(tx, ctx, enc.keyId);
      if (key === undefined) {
        services.log("updates.dkim_key_missing", { level: "warn", keyId: enc.keyId });
        return undefined;
      }
      const pem = Buffer.from(await decryptBytes(key.key, d.privateKeyEnc)).toString("utf8");
      return {
        domain: d.domain,
        dkim: { domainName: d.domain, keySelector: d.selector, privateKey: pem },
      };
    },
  };
}

export type SendingDomainService = ReturnType<typeof createSendingDomainService>;
