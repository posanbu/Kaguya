export interface Trigger<TPayload> {
  start(handler: (payload: TPayload) => Promise<void>): () => void;
}

export interface IntervalTimerApi {
  setInterval(
    handler: () => void,
    intervalMs: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export interface TimeoutTimerApi {
  setTimeout(
    handler: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemIntervalTimers: IntervalTimerApi = {
  setInterval: (handler, intervalMs) =>
    globalThis.setInterval(handler, intervalMs),
  clearInterval: (handle) => globalThis.clearInterval(handle),
};

const systemTimeoutTimers: TimeoutTimerApi = {
  setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const MAX_TIMEOUT_MS = 2_147_483_647;

export class ManualTrigger<TPayload> implements Trigger<TPayload> {
  private handler: ((payload: TPayload) => Promise<void>) | undefined;

  start(handler: (payload: TPayload) => Promise<void>): () => void {
    this.handler = handler;

    return () => {
      if (this.handler === handler) {
        this.handler = undefined;
      }
    };
  }

  async fire(payload: TPayload): Promise<void> {
    if (this.handler === undefined) {
      throw new Error("manual trigger has not been started");
    }

    await this.handler(payload);
  }
}

export interface IntervalTriggerOptions<TPayload> {
  intervalMs: number;
  createPayload: () => TPayload;
  onError?: (error: unknown) => void;
  timers?: IntervalTimerApi;
}

export class IntervalTrigger<TPayload> implements Trigger<TPayload> {
  private readonly intervalMs: number;
  private readonly createPayload: () => TPayload;
  private readonly onError: (error: unknown) => void;
  private readonly timers: IntervalTimerApi;

  constructor(options: IntervalTriggerOptions<TPayload>) {
    if (
      !Number.isInteger(options.intervalMs) ||
      options.intervalMs <= 0 ||
      options.intervalMs > MAX_TIMEOUT_MS
    ) {
      throw new Error(
        `intervalMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`,
      );
    }
    this.intervalMs = options.intervalMs;
    this.createPayload = options.createPayload;
    this.onError = options.onError ?? reportUnhandledError;
    this.timers = options.timers ?? systemIntervalTimers;
  }

  start(handler: (payload: TPayload) => Promise<void>): () => void {
    let cancelled = false;
    const handle = this.timers.setInterval(() => {
      void Promise.resolve()
        .then(() => {
          if (cancelled) {
            return;
          }
          const payload = this.createPayload();
          if (cancelled) {
            return;
          }
          return handler(payload);
        })
        .catch((error: unknown) => notifyError(this.onError, error));
    }, this.intervalMs);

    return () => {
      if (!cancelled) {
        cancelled = true;
        this.timers.clearInterval(handle);
      }
    };
  }
}

export type NextRunCalculator = (expression: string, after: Date) => Date;

export interface CronTriggerOptions<TPayload> {
  expression: string;
  calculateNextRun: NextRunCalculator;
  createPayload: () => TPayload;
  now?: () => Date;
  onError?: (error: unknown) => void;
  timers?: TimeoutTimerApi;
}

export class CronTrigger<TPayload> implements Trigger<TPayload> {
  readonly expression: string;

  private readonly calculateNextRun: NextRunCalculator;
  private readonly createPayload: () => TPayload;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private readonly timers: TimeoutTimerApi;

  constructor(options: CronTriggerOptions<TPayload>) {
    assertSixFieldExpression(options.expression);
    assertCronFields(options.expression);
    this.expression = options.expression.trim();
    this.calculateNextRun = options.calculateNextRun;
    this.createPayload = options.createPayload;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? reportUnhandledError;
    this.timers = options.timers ?? systemTimeoutTimers;
  }

  start(handler: (payload: TPayload) => Promise<void>): () => void {
    let cancelled = false;
    let handle: ReturnType<typeof setTimeout> | undefined;

    const arm = (targetTime: number): void => {
      if (cancelled) {
        return;
      }

      const remainingMs = targetTime - this.now().getTime();
      if (!Number.isFinite(remainingMs)) {
        throw new Error("cron next-run calculator returned an invalid date");
      }

      handle = this.timers.setTimeout(
        () => {
          if (cancelled) {
            return;
          }
          if (targetTime > this.now().getTime()) {
            arm(targetTime);
            return;
          }

          void Promise.resolve()
            .then(() => {
              if (cancelled) {
                return;
              }
              const payload = this.createPayload();
              if (cancelled) {
                return;
              }
              return handler(payload);
            })
            .then(scheduleSafely, (error: unknown) => {
              notifyError(this.onError, error);
              scheduleSafely();
            });
        },
        Math.min(Math.max(0, remainingMs), MAX_TIMEOUT_MS),
      );
    };

    const schedule = (): void => {
      if (cancelled) {
        return;
      }

      const after = this.now();
      const nextRun = this.calculateNextRun(this.expression, after);
      const delayMs = nextRun.getTime() - after.getTime();
      if (!Number.isFinite(delayMs) || delayMs <= 0) {
        throw new Error("cron next-run calculator returned an invalid date");
      }
      arm(nextRun.getTime());
    };

    const scheduleSafely = (): void => {
      try {
        schedule();
      } catch (error) {
        notifyError(this.onError, error);
      }
    };

    schedule();

    return () => {
      cancelled = true;
      if (handle !== undefined) {
        this.timers.clearTimeout(handle);
      }
    };
  }
}

function assertSixFieldExpression(expression: string): void {
  if (expression.trim().split(/\s+/u).length !== 6) {
    throw new Error("cron expression must be a six-field expression");
  }
}

const cronFieldRanges = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  { minimum: 1, maximum: 12 },
  { minimum: 0, maximum: 7 },
] as const;

const monthAliases = new Map(
  [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ].map((name, index) => [name, index + 1]),
);
const weekdayAliases = new Map(
  ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((name, index) => [
    name,
    index,
  ]),
);

function assertCronFields(expression: string): void {
  const fields = expression.trim().split(/\s+/u);
  for (const [index, field] of fields.entries()) {
    const range = cronFieldRanges[index];
    if (range === undefined) {
      throw new Error("invalid cron expression");
    }
    if (field.includes("?")) {
      if ((index === 3 || index === 5) && field === "?") {
        continue;
      }
      throw new Error("invalid cron expression");
    }
    for (const segment of field.split(",")) {
      assertCronSegment(segment, index, range.minimum, range.maximum);
    }
  }
}

function assertCronSegment(
  segment: string,
  fieldIndex: number,
  minimum: number,
  maximum: number,
): void {
  if (segment === "*") {
    return;
  }

  const stepParts = segment.split("/");
  if (stepParts.length > 2) {
    throw new Error("invalid cron expression");
  }
  const [base, step] = stepParts;
  if (base === undefined || base.length === 0) {
    throw new Error("invalid cron expression");
  }
  if (step !== undefined) {
    const parsedStep = /^\d+$/u.test(step) ? Number(step) : Number.NaN;
    if (!Number.isSafeInteger(parsedStep) || parsedStep <= 0) {
      throw new Error("invalid cron expression");
    }
  }
  if (base === "*") {
    return;
  }

  const rangeParts = base.split("-");
  if (rangeParts.length > 2) {
    throw new Error("invalid cron expression");
  }
  const start = parseCronValue(
    rangeParts[0] ?? "",
    fieldIndex,
    minimum,
    maximum,
  );
  if (rangeParts[1] !== undefined) {
    const end = parseCronValue(rangeParts[1], fieldIndex, minimum, maximum);
    if (start > end) {
      throw new Error("invalid cron expression");
    }
  }
}

function parseCronValue(
  value: string,
  fieldIndex: number,
  minimum: number,
  maximum: number,
): number {
  const normalized = value.toUpperCase();
  const alias =
    fieldIndex === 4
      ? monthAliases.get(normalized)
      : fieldIndex === 5
        ? weekdayAliases.get(normalized)
        : undefined;
  const parsed = alias ?? (/^\d+$/u.test(value) ? Number(value) : Number.NaN);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("invalid cron expression");
  }
  return parsed;
}

function reportUnhandledError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function notifyError(onError: (error: unknown) => void, error: unknown): void {
  try {
    onError(error);
  } catch (reportingError) {
    reportUnhandledError(reportingError);
  }
}
