import type { AppConfig } from "@fundroom/config";
import {
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as PinoLoggerOptions,
  pino,
} from "pino";

/*
 * Structured logs (design/07 §5, §16 "Observability"): pino JSON to stdout, one line per
 * event, `event` as the discriminator so the kernel packages' `log(event, fields)` hooks
 * map 1:1. Redaction is defence in depth: the hooks are written never to pass emails,
 * codes or tokens, and these paths catch a slip. Investor ids are not hashed here because
 * the kernel logs ids only (never names or documents).
 */
export type Logger = PinoLogger;
export type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export const REDACT_PATHS: readonly string[] = [
  "email",
  "*.email",
  "*.*.email",
  "password",
  "*.password",
  "token",
  "*.token",
  "*.*.token",
  "code",
  "*.code",
  "secret",
  "*.secret",
  "cookie",
  "*.cookie",
  "authorization",
  "*.authorization",
  "headers.cookie",
  "headers.authorization",
  "headers['set-cookie']",
  "*.otp",
  "*.recoveryCodes",
  "*.secretBase32",
];

export interface LoggerOptions {
  readonly level: AppConfig["raw"]["LOG_LEVEL"];
  readonly service?: string | undefined;
  readonly version?: string | undefined;
  /** Test seam: write JSON lines here instead of stdout. */
  readonly destination?: DestinationStream | undefined;
}

export function createLogger(options: LoggerOptions): Logger {
  const base: Record<string, unknown> = { service: options.service ?? "fundroom" };
  if (options.version !== undefined) base["version"] = options.version;
  const opts: PinoLoggerOptions = {
    level: options.level,
    base,
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
    formatters: { level: (label: string) => ({ level: label }) },
  };
  return options.destination ? pino(opts, options.destination) : pino(opts);
}

const LEVEL_BY_SUFFIX: readonly [RegExp, "error" | "warn" | "info" | "debug"][] = [
  [/(^|[._])(failed|error|rejected|mismatch|tamper|lockout|denied)($|[._])/u, "warn"],
  [
    /(^|[._])(swept|registered|ensured|collected|dispatched|touched|hit|miss|cached)($|[._])/u,
    "debug",
  ],
];

/**
 * Adapts a pino child to the kernel `log(event, fields)` hook. Level is inferred from the
 * event name (failures → warn, chatter → debug, the rest → info); a hook that needs an
 * explicit level passes `level` in fields.
 */
export function logHook(logger: Logger, component: string): Log {
  const child = logger.child({ component });
  return (event, fields) => {
    const { level: explicit, ...rest } = fields ?? {};
    let level: "error" | "warn" | "info" | "debug" = "info";
    if (
      explicit === "error" ||
      explicit === "warn" ||
      explicit === "info" ||
      explicit === "debug"
    ) {
      level = explicit;
    } else {
      for (const [re, l] of LEVEL_BY_SUFFIX) {
        if (re.test(event)) {
          level = l;
          break;
        }
      }
    }
    child[level]({ ...rest, event }, event);
  };
}
