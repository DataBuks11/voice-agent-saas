export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export function createLogger(scope: string, level: LogLevel = "info"): Logger {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const emit = (l: LogLevel, msg: string, meta?: unknown) => {
    if (order[l] < order[level]) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: l, scope, msg, meta });
    if (l === "error") console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, x) => emit("debug", m, x),
    info: (m, x) => emit("info", m, x),
    warn: (m, x) => emit("warn", m, x),
    error: (m, x) => emit("error", m, x),
  };
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 500,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function paginate<T>(items: T[], limit: number, offset: number): { items: T[]; total: number } {
  return { items: items.slice(offset, offset + limit), total: items.length };
}

/** Rough token estimate (~4 chars/token) for budget enforcement before real tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
