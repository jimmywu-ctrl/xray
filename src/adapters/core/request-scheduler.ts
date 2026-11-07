export type RequestPriority = "new-call" | "live" | "interactive" | "background";

const PRIORITY: Record<RequestPriority, number> = {
  "new-call": 0,
  live: 1,
  interactive: 2,
  background: 3,
};

export class ApiRateLimitError extends Error {
  constructor(readonly retryAfterMs: number | undefined, message = "HTTP 429") {
    super(message);
    this.name = "ApiRateLimitError";
  }
}

export class ApiAccessBlockedError extends ApiRateLimitError {
  constructor(message: string, retryAfterMs?: number) {
    super(retryAfterMs, message);
    this.name = "ApiAccessBlockedError";
  }
}

interface PendingRequest<T = unknown> {
  key: string;
  priority: RequestPriority;
  order: number;
  queuedAt: number;
  task: (signal?: AbortSignal) => Promise<T>;
  cacheMs: number;
  bucket?: string;
  intervalMs: number;
  signal?: AbortSignal;
  abortFromQueue?: () => void;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface CachedValue {
  until: number;
  value: unknown;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("request cancelled"));
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new Error("request cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Per-provider request gate for priority, coalescing, pacing, caching and backoff. */
export class RequestScheduler {
  private pending: PendingRequest[] = [];
  private running = 0;
  private backgroundRunning = 0;
  private serial = 0;
  private nextAllowed = new Map<string, number>();
  private activeByKey = new Map<string, Promise<unknown>>();
  private consumers = new Map<string, { controller: AbortController; count: number; promise: Promise<unknown> }>();
  private cache = new Map<string, CachedValue>();
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private blockedUntil = 0;
  private blockReason: string | null = null;
  private blocks = 0;
  private lastBlockAt = 0;
  private addedDelayMs = 0;
  private recentCallStarts: number[] = [];

  constructor(
    private readonly provider: string,
    private readonly concurrency = 2,
    private readonly urgentConcurrency = concurrency,
    private readonly timeoutMs = 60_000,
    private readonly backgroundConcurrency?: number,
  ) {}

  get paused(): boolean {
    return Date.now() < this.blockedUntil;
  }
  resumeAfterCredentialChange(): void {
    this.blockedUntil = 0;
    this.blockReason = null;
    this.cache.clear();
    this.dispatch();
  }

  get waitStatus() {
    const now = Date.now();
    const oldestQueuedAt = this.pending.reduce(
      (oldest, entry) => Math.min(oldest, entry.queuedAt),
      now,
    );
    return {
      paused: now < this.blockedUntil,
      retryAt: now < this.blockedUntil ? this.blockedUntil : null,
      waitSeconds: now < this.blockedUntil ? Math.ceil((this.blockedUntil - now) / 1000) : 0,
      reason: now < this.blockedUntil ? this.blockReason : null,
      queued: this.pending.length,
      active: this.running,
      oldestWaitMs: this.pending.length ? now - oldestQueuedAt : 0,
    };
  }

  run<T>(
    key: string,
    priority: RequestPriority,
    task: (signal?: AbortSignal) => Promise<T>,
    cacheMs = 0,
    pacing?: { bucket: string; intervalMs: number; signal?: AbortSignal },
  ): Promise<T> {
    const signal = pacing?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('request cancelled'));
    let shared = this.consumers.get(key);
    if (!shared) {
      const controller = new AbortController();
      const promise = this.runShared(key, priority, task, cacheMs, { bucket: pacing?.bucket ?? key, intervalMs: pacing?.intervalMs ?? 0, signal: controller.signal });
      shared = { controller, count: 0, promise };
      this.consumers.set(key, shared);
      const entry = shared;
      const cleanup = () => { if (this.consumers.get(key) === entry) this.consumers.delete(key); };
      void promise.then(cleanup, cleanup);
    } else {
      const pending = this.pending.find(entry => entry.key === key);
      if (pending && PRIORITY[priority] < PRIORITY[pending.priority]) pending.priority = priority;
    }
    const entry = shared;
    entry.count++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener('abort', cancel);
        entry.count--;
        return true;
      };
      const cancel = () => {
        if (!release()) return;
        reject(signal?.reason ?? new Error('request cancelled'));
        if (!entry.count) {
          if (this.consumers.get(key) === entry) this.consumers.delete(key);
          entry.controller.abort(signal?.reason);
        }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      entry.promise.then(value => { if (release()) resolve(value as T); }, error => { if (release()) reject(error); });
    });
  }

  private runShared<T>(
    key: string,
    priority: RequestPriority,
    task: (signal?: AbortSignal) => Promise<T>,
    cacheMs = 0,
    pacing?: { bucket: string; intervalMs: number; signal?: AbortSignal },
  ): Promise<T> {
    const signal = pacing?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("request cancelled"));

    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.until > now) return Promise.resolve(cached.value as T);
    this.cache.delete(key);

    const existing = this.activeByKey.get(key);
    if (existing) {
      const waiting = this.pending.find((entry) => entry.key === key);
      if (waiting && PRIORITY[priority] < PRIORITY[waiting.priority]) waiting.priority = priority;
      return withAbort(existing as Promise<T>, signal);
    }

    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    const entry: PendingRequest<T> = {
      key,
      priority,
      order: this.serial++,
      queuedAt: now,
      task,
      cacheMs,
      bucket: pacing?.bucket,
      intervalMs: Math.max(0, pacing?.intervalMs ?? 0),
      signal,
      resolve,
      reject,
    };
    this.activeByKey.set(key, promise);
    this.pending.push(entry as PendingRequest);

    if (signal) {
      const remove = () => {
        const index = this.pending.indexOf(entry as PendingRequest);
        if (index < 0) return;
        this.pending.splice(index, 1);
        this.activeByKey.delete(key);
        reject(asError(signal.reason ?? new Error("request cancelled")));
        this.dispatch();
      };
      entry.abortFromQueue = remove;
      signal.addEventListener("abort", remove, { once: true });
    }

    this.dispatch();
    return promise;
  }

  private rank(entry: PendingRequest, now: number): number {
    // Never age background work above live overlay requests. A slow history
    // lookup may wait; it must not take the live quote slot from the overlay.
    return PRIORITY[entry.priority];
  }

  private limitFor(entry: PendingRequest, now: number): number {
    if (entry.priority === "new-call") return this.urgentConcurrency;
    if (entry.priority === "background" && this.backgroundConcurrency !== undefined) {
      return this.concurrency;
    }
    if (entry.priority === "background" && now - entry.queuedAt < 15_000) {
      return Math.max(1, this.concurrency - 1);
    }
    return this.concurrency;
  }

  private urgentBurstDelay(entry: PendingRequest, now: number): number {
    if (entry.priority !== "new-call" || this.urgentConcurrency <= this.concurrency) return 0;
    this.recentCallStarts = this.recentCallStarts.filter((at) => at > now - 5_000);
    return this.recentCallStarts.length >= 12 ? this.recentCallStarts[0]! + 5_000 : 0;
  }

  private dispatch(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    const now = Date.now();
    this.pending.sort((a, b) => this.rank(a, now) - this.rank(b, now) || a.order - b.order);

    while (this.pending.length && this.running < this.urgentConcurrency) {
      const at = Date.now();
      const index = this.pending.findIndex((entry) => {
        if (this.running >= this.limitFor(entry, at)) return false;
        if(entry.priority === "background" && this.backgroundConcurrency !== undefined && this.backgroundRunning >= this.backgroundConcurrency) return false;
        const bucketReady = entry.bucket ? this.nextAllowed.get(entry.bucket) ?? 0 : 0;
        return Math.max(this.blockedUntil, this.urgentBurstDelay(entry, at), bucketReady) <= at;
      });
      if (index < 0) break;
      const [entry] = this.pending.splice(index, 1);
      if (!entry) break;
      entry.signal?.removeEventListener("abort", entry.abortFromQueue!);
      if (entry.priority === "new-call" && this.urgentConcurrency > this.concurrency) {
        this.recentCallStarts.push(at);
      }
      if (entry.bucket) {
        this.nextAllowed.set(entry.bucket, at + Math.max(entry.intervalMs, this.addedDelayMs));
      }
      this.execute(entry);
    }

    if (!this.pending.length || this.running >= this.urgentConcurrency) return;
    const at = Date.now();
    const deadlines = this.pending
      .filter((entry) => this.running < this.limitFor(entry, at) && !(entry.priority === "background" && this.backgroundConcurrency !== undefined && this.backgroundRunning >= this.backgroundConcurrency))
      .map((entry) => Math.max(
        this.blockedUntil,
        this.urgentBurstDelay(entry, at),
        entry.bucket ? this.nextAllowed.get(entry.bucket) ?? 0 : 0,
      ));
    if (!deadlines.length) return;
    const delay = Math.max(1, Math.min(...deadlines) - at);
    this.wakeTimer = setTimeout(() => this.dispatch(), delay);
  }

  private execute(entry: PendingRequest): void {
    this.running++;
    const background = entry.priority === "background";
    if(background)this.backgroundRunning++;
    const controller = new AbortController();
    const cancel = () => controller.abort(entry.signal?.reason);
    entry.signal?.addEventListener("abort",cancel,{once:true});
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {const error=new Error(`${this.provider} request exceeded ${Math.ceil(this.timeoutMs / 1000)}s`);controller.abort(error);reject(error);}, this.timeoutMs);
    });
    const operation = Promise.resolve().then(() => {
      entry.signal?.throwIfAborted();
      return entry.task(controller.signal);
    });

    void withAbort(Promise.race([operation, timeout]), entry.signal)
      .then((value) => {
        this.reduceBackoffAfterHealthyPeriod();
        if (entry.cacheMs > 0) this.saveCache(entry.key, value, entry.cacheMs);
        entry.resolve(value);
      })
      .catch((cause: unknown) => {
        const error = asError(cause);
        if (error instanceof ApiRateLimitError) this.pauseForProvider(error);
        entry.reject(error);
      })
      .finally(async () => {
        clearTimeout(timer!);
        entry.signal?.removeEventListener("abort",cancel);
        await operation.catch(()=>{});
        if(background)this.backgroundRunning--;
        this.activeByKey.delete(entry.key);
        this.running--;
        this.dispatch();
      });
  }

  private saveCache(key: string, value: unknown, ttl: number): void {
    const now = Date.now();
    this.cache.set(key, { until: now + ttl, value });
    if (this.cache.size <= 5_000) return;
    for (const [cacheKey, entry] of this.cache) {
      if (entry.until <= now) this.cache.delete(cacheKey);
    }
    while (this.cache.size > 5_000) {
      const first = this.cache.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.cache.delete(first);
    }
  }

  private reduceBackoffAfterHealthyPeriod(): void {
    if (!this.lastBlockAt || Date.now() - this.lastBlockAt < 5 * 60_000) return;
    this.blocks = 0;
    this.addedDelayMs = Math.max(0, this.addedDelayMs - 250);
    this.lastBlockAt = this.addedDelayMs ? Date.now() : 0;
  }

  private pauseForProvider(error: ApiRateLimitError): void {
    this.blocks++;
    this.lastBlockAt = Date.now();
    this.addedDelayMs = Math.min(5_000, Math.max(1_000, this.addedDelayMs * 2));
    const supplied = error.retryAfterMs;
    const fallback = error instanceof ApiAccessBlockedError ? 60_000 : 30_000;
    const wait = Number.isFinite(supplied) && (supplied ?? 0) > 0
      ? supplied!
      : Math.min(15 * 60_000, fallback * 2 ** Math.min(8, this.blocks - 1));
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + wait);
    this.blockReason = error.message;
    console.error(`[api:${this.provider}] ${error.name}: ${error.message}; paused ${Math.ceil(wait / 1000)}s`);
  }
}

export function priorityOf(...priorities: RequestPriority[]): RequestPriority {
  return priorities.reduce(
    (best, current) => PRIORITY[current] < PRIORITY[best] ? current : best,
    "background",
  );
}
