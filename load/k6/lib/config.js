/*
 * Settings for every script, from `k6 run -e NAME=value` (or the environment).
 *
 *   TARGET_URL     where k6 sends requests            default http://localhost:3000
 *   PUBLIC_ORIGIN  the app's BASE_URL origin: sent as `Host` and `Origin`, because the app routes
 *                  and CSRF-checks by the origin it was configured with, which differs from
 *                  TARGET_URL when k6 runs in a container (http://app:3000)
 *                                                      default TARGET_URL
 *   MAILPIT_URL    Mailpit's HTTP API (sign-in codes)  default http://localhost:8025
 *   OWNER_EMAIL    the seeded owner                    default founder@example.com (seed-demo)
 *   OWNER_TOTP_SECRET  the owner's TOTP secret, printed by the first run that enrolled it
 *   INVESTORS      investor sessions to open in setup  default 10
 *   TARGET_RPS     load scenario's peak request rate   default 200 (plan §16: 200 RPS/tenant)
 *   RAMP           load scenario ramp-up duration      default 1m
 *   HOLD           load scenario time at peak          default 3m
 *   SOAK           soak scenario duration (0 = off)    default 0
 *   SEED_CONTENT   upload a PDF + send an update in setup when there is none   default true
 */
export const TARGET_URL = (__ENV.TARGET_URL || "http://localhost:3000").replace(/\/$/, "");
export const PUBLIC_ORIGIN = (__ENV.PUBLIC_ORIGIN || TARGET_URL).replace(/\/$/, "");
export const MAILPIT_URL = (__ENV.MAILPIT_URL || "http://localhost:8025").replace(/\/$/, "");
export const OWNER_EMAIL = __ENV.OWNER_EMAIL || "founder@example.com";
export const OWNER_TOTP_SECRET = __ENV.OWNER_TOTP_SECRET || "";
export const INVESTORS = Number(__ENV.INVESTORS || 10);
export const TARGET_RPS = Number(__ENV.TARGET_RPS || 200);
export const RAMP = __ENV.RAMP || "1m";
export const HOLD = __ENV.HOLD || "3m";
export const SOAK = __ENV.SOAK || "0";
export const SEED_CONTENT = (__ENV.SEED_CONTENT || "true") !== "false";

export const HOST = PUBLIC_ORIGIN.replace(/^https?:\/\//, "");
