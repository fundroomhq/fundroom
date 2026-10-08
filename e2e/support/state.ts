import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * What `00-setup` learns that later specs need: the owner's enrolled TOTP secret and the last
 * code the server accepted (a replay inside the same window is refused). Spec files do not
 * share module state, so it goes through a gitignored file next to the suite. It is only valid
 * for the stack that `00-setup` ran against — `stack:down` (-v) makes it stale, and the next
 * `00-setup` overwrites it.
 */
export interface StackState {
  readonly totpSecret: string;
  readonly lastCode: string;
  /** `30-a11y`'s seed and signed-in browser states, so a worker restart after a failed page
   *  test does not upload, grant and send everything again. */
  readonly a11y?: A11ySeed | undefined;
}

export interface A11ySeed {
  readonly documentId: string;
  readonly draftId: string;
  readonly sentSlug: string;
  readonly staff: StorageState;
  readonly investor: StorageState;
}

/** Playwright's `storageState()` shape, kept opaque here. */
export type StorageState = Exclude<
  NonNullable<import("@playwright/test").BrowserContextOptions["storageState"]>,
  string
>;

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".state", "stack.json");

export function saveStackState(state: StackState): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(state, null, 2)}\n`);
}

export function loadStackState(): StackState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<StackState>;
    if (typeof parsed.totpSecret !== "string" || parsed.totpSecret === "") return undefined;
    return { totpSecret: parsed.totpSecret, lastCode: parsed.lastCode ?? "", a11y: parsed.a11y };
  } catch {
    return undefined;
  }
}
