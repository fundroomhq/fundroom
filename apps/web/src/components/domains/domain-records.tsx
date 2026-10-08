import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fundroomhq/ui";
import type {
  CustomDomain,
  CustomDomainStatus,
  DnsAnswer,
  DnsInstruction,
  DomainAnswer,
} from "../../lib/domains-queries.js";
import { m } from "../../paraglide/messages.js";
import { CopyButton } from "../copy-button.js";

/*
 * The records table and the status vocabulary, shared by `/admin/domains` and the setup
 * wizard's domain step (E2.1 §3). Only the presentation is shared — never the mutation, the
 * `brand-controls.tsx` rule: admin raises a toast and lets `useGuardedMutation` bounce a weak
 * session to the step-up screen, while the wizard has its own security step to send the founder
 * back to, and navigating out of a half-finished wizard would lose the steps behind it.
 */

export function domainStatusLabel(status: CustomDomainStatus): string {
  switch (status) {
    case "dns_ok":
      return m.domains_status_dns_ok();
    case "active":
      return m.domains_status_active();
    case "failed":
      return m.domains_status_failed();
    default:
      return m.domains_status_pending();
  }
}

export function domainStatusVariant(
  status: CustomDomainStatus,
): "default" | "warning" | "destructive" {
  switch (status) {
    case "dns_ok":
    case "active":
      return "default";
    case "failed":
      return "destructive";
    default:
      return "warning";
  }
}

/**
 * What the resolvers saw for one record — not the verdict. The verdict is `detail`, one
 * sentence the server wrote from both answers at once, and it is the authority: an apex that
 * answers A/AAAA instead of a CNAME is routed correctly but cannot be reported as "found" from
 * this row alone, because whether those addresses are ours is not something the row knows.
 * The runbook's advice ("read the answer before theorising") only works if this column reports
 * observation rather than judgement.
 */
type RecordState = "unchecked" | "found" | "mismatch" | "missing" | "nxdomain" | "flattened";

function answerFor(record: DnsInstruction, answer: DomainAnswer): DnsAnswer | undefined {
  const picked = record.type === "TXT" ? answer.txt : record.type === "A" ? answer.a : answer.cname;
  return picked ?? undefined;
}

function matches(answer: DnsAnswer, value: string): boolean {
  const want = value.toLowerCase().replace(/\.$/u, "");
  return answer.values.some((v) => v.toLowerCase().replace(/\.$/u, "") === want);
}

export function recordState(record: DnsInstruction, answer: DomainAnswer | null): RecordState {
  if (answer === null) return "unchecked";
  const own = answerFor(record, answer);
  if (own === undefined) return "unchecked";
  if (matches(own, record.value)) return "found";
  if (own.values.length > 0) return "mismatch";
  // An apex whose provider flattens the CNAME answers address records instead. Reported as
  // what it is; whether those addresses are the edge's is the verdict sentence's business.
  if (record.type !== "TXT") {
    const flat = [answer.a, answer.aaaa].filter((a) => (a?.values.length ?? 0) > 0);
    if (flat.length > 0) return "flattened";
  }
  return own.rcode === "nxdomain" ? "nxdomain" : "missing";
}

function recordStateLabel(state: RecordState): string {
  switch (state) {
    case "found":
      return m.domains_rec_found();
    case "mismatch":
      return m.domains_rec_mismatch();
    case "missing":
      return m.domains_rec_missing();
    case "nxdomain":
      return m.domains_rec_nxdomain();
    case "flattened":
      return m.domains_rec_flattened();
    default:
      return m.domains_rec_unchecked();
  }
}

export function DomainRecordsTable({ domain }: { domain: CustomDomain }) {
  return (
    <Table aria-label={m.domains_records_for({ host: domain.hostname })}>
      <TableHeader>
        <TableRow>
          <TableHead>{m.domains_rec_type()}</TableHead>
          <TableHead>{m.domains_rec_name()}</TableHead>
          <TableHead>{m.domains_rec_value()}</TableHead>
          <TableHead>{m.domains_rec_status()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {domain.records.map((record) => (
          <TableRow key={`${record.type}:${record.name}`}>
            <TableCell>
              {record.type}
              {record.required ? null : (
                <span className="block text-xs text-muted-foreground">
                  {m.domains_rec_optional()}
                </span>
              )}
            </TableCell>
            <TableCell className="font-mono text-xs break-all">{record.name}</TableCell>
            <TableCell className="font-mono text-xs break-all">
              <span className="flex flex-wrap items-center gap-2">
                <span>{record.value}</span>
                <CopyButton value={record.value} label={m.common_copy()} />
              </span>
            </TableCell>
            <TableCell>{recordStateLabel(recordState(record, domain.answer))}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
