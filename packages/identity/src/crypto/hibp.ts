import { createHash } from "node:crypto";
import type { OutboundFetch } from "@fundroom/ports";

/*
 * Have I Been Pwned "Pwned Passwords" range API with k-anonymity: only the first five hex
 * characters of the SHA-1 leave the server. `Add-Padding` makes response sizes uniform.
 * https://haveibeenpwned.com/API/v3#SearchingPwnedPasswordsByRange
 */
export const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";

export type BreachCheck =
  | { readonly status: "clear" }
  | { readonly status: "breached"; readonly count: number }
  | { readonly status: "unavailable"; readonly reason: string };

export interface BreachCheckOptions {
  readonly fetch: OutboundFetch;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

export async function checkPasswordBreached(
  password: string,
  options: BreachCheckOptions,
): Promise<BreachCheck> {
  const sha1 = createHash("sha1").update(password.normalize("NFKC")).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const url = `${options.baseUrl ?? HIBP_RANGE_URL}${prefix}`;
  try {
    const res = await options.fetch(url, {
      headers: { "Add-Padding": "true", "User-Agent": "FundRoom" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!res.ok) return { status: "unavailable", reason: `HTTP ${res.status}` };
    const body = await res.text();
    for (const line of body.split(/\r?\n/u)) {
      const [hashSuffix, countText] = line.trim().split(":");
      if (hashSuffix?.toUpperCase() === suffix) {
        const count = Number(countText ?? "0");
        // Padded rows carry a count of 0 and are not real matches.
        if (count > 0) return { status: "breached", count };
      }
    }
    return { status: "clear" };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
