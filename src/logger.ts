export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** One JSON object per line. Easy to grep, easy to ship to any log store. */
export function createLogger(level: LogLevel = "info"): Logger {
  const write = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields });
    (lvl === "error" || lvl === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Phone numbers are personal data. Logs keep the country code and the last
 * four digits, which is enough to debug without storing the full number.
 */
export function maskWaId(waId: string): string {
  if (waId.length <= 6) return "***";
  return `${waId.slice(0, 2)}***${waId.slice(-4)}`;
}
