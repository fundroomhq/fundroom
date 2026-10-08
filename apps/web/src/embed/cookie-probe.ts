/*
 * Can this iframe set a partitioned cookie? (design/08 §1c "Fallback".) We set a plain
 * (non-HttpOnly) probe cookie with the same attributes as the session cookie, read it back,
 * and delete it. The result decides between "sign in here" and "Open in a new tab".
 */
export const PROBE_COOKIE = "sh_probe";

export interface ProbeTarget {
  cookie: string;
  readonly location?: { protocol: string; hostname: string } | undefined;
}

export type ProbeResult = "ok" | "insecure" | "blocked";

export function probeCookies(doc: ProbeTarget): ProbeResult {
  const loc = doc.location;
  if (loc !== undefined && loc.protocol !== "https:" && !isLocalhost(loc.hostname)) {
    // Secure/Partitioned cookies need https; browsers exempt localhost only.
    return "insecure";
  }
  try {
    doc.cookie = `${PROBE_COOKIE}=1; Path=/; SameSite=None; Secure; Partitioned; Max-Age=60`;
    const ok = doc.cookie.split(";").some((c) => c.trim().startsWith(`${PROBE_COOKIE}=`));
    doc.cookie = `${PROBE_COOKIE}=; Path=/; SameSite=None; Secure; Partitioned; Max-Age=0`;
    return ok ? "ok" : "blocked";
  } catch {
    return "blocked";
  }
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");
}
