import { WechatWatcher, type BackfillScanTick, type WatchEvent } from "../wechat/watch.js";
import { RECENT_BACKFILL, type BackfillScanProgress, type GroupMsg } from "./messages.js";
import { acceptsSender } from "./sender-filter.js";
import type { SenderFilter } from "./types.js";

type StartPosition = { sinceTs: number } | { lastN: number };
type MessageEvent = Extract<WatchEvent, { t: "msg" }>;
type WatchStatusEvent = Exclude<WatchEvent, { t: "msg" }>;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const PROGRESS_INTERVAL_MS = 250;

/** Runs one independent WeChat reader for each selected group. */
export class WatchManager {
  knownMessages: (group: string) => GroupMsg[] = () => [];
  knownMessageAccepted: (group: string, id: string) => boolean = () => false;
  private acceptedMessages = new Set<string>();

  private readonly running = new Map<string, WechatWatcher>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly startOptions = new Map<string, StartPosition>();
  private readonly lastProcessedAt = new Map<string, number>();
  private readonly wantedGroups = new Set<string>();
  private lookupReader?: WechatWatcher;
  private senderFilters: Record<string, SenderFilter> = {};
  private stopped = false;
  private firstBatch = true;
  private backfillPromise?: Promise<{ groups: number; messages: number }>;

  constructor(
    private readonly initialSince: number,
    private readonly onMessage: (message: GroupMsg) => boolean | void,
    private readonly onStatus: (event: WatchStatusEvent, group: string) => void,
  ) {}

  get reader(): WechatWatcher {
    return (this.lookupReader ??= new WechatWatcher());
  }

  get watchedGroupCount(): number {
    return this.running.size;
  }

  get readyGroupCount(): number {
    return [...this.wantedGroups].filter((group) => this.running.get(group)?.ready).length;
  }

  get selectedGroupCount(): number {
    return this.wantedGroups.size;
  }

  status() {
    return {
      selected: this.selectedGroupCount,
      running: this.watchedGroupCount,
      ready: this.readyGroupCount,
      retrying: this.retryTimers.size,
      staleDatabases: [...this.running.values()].filter(w => w.health().staleDatabase).length,
      details: [...this.running.entries()].map(([group,w]) => ({ group, ready: w.ready, ...w.health() })),
    };
  }

  displayName(username: string): string {
    try { return this.reader.display(username); }
    catch { return username; }
  }

  readAround(group: string, timestamp: number, before: number, after: number, sourceId?: string) {
    const reader = this.running.get(group) ?? this.reader;
    return reader.readAround(group, timestamp, before, after, sourceId);
  }

  setSince(group: string, sinceTs: number): void {
    if (!this.running.has(group) && Number.isFinite(sinceTs)) {
      this.startOptions.set(group, { sinceTs: Math.floor(sinceTs) });
    }
  }

  startInitial(groups: string[], filters: Record<string, SenderFilter> = this.senderFilters): void {
    this.firstBatch = true;
    this.sync(groups, filters);
    this.firstBatch = false;
  }

  /** Make the active watcher set match the user-selected group list. */
  sync(groups: string[], filters: Record<string, SenderFilter> = this.senderFilters): void {
    this.senderFilters = filters;
    this.stopped = false;
    this.wantedGroups.clear();
    for (const group of groups) this.wantedGroups.add(group);

    for (const group of this.startOptions.keys()) {
      if (!this.wantedGroups.has(group)) this.startOptions.delete(group);
    }
    for (const [group, watcher] of this.running) {
      if (!this.wantedGroups.has(group)) {
        this.stopGroup(group, watcher);
        this.retryAttempts.delete(group);
      }
    }
    for (const [group, timer] of this.retryTimers) {
      if (!this.wantedGroups.has(group)) this.clearRetry(group, timer);
    }
    for (const group of this.wantedGroups) {
      if (!this.running.has(group) && !this.retryTimers.has(group)) {
        try { this.startGroup(group); }
        catch (error) { this.handleFailure(group, null, error); }
      }
    }
  }

  private startGroup(group: string): void {
    const committedAt = this.lastProcessedAt.get(group);
    const options = committedAt !== undefined
      ? { sinceTs: Math.max(0, committedAt - 120) }
      : this.startOptions.get(group) ?? (
      this.firstBatch ? { sinceTs: this.initialSince } : { lastN: RECENT_BACKFILL }
    );
    this.startOptions.set(group, options);

    const watcher = new WechatWatcher();
    const known = this.knownMessages(group)
      .filter((message): message is GroupMsg & { sourceId: string } => Boolean(message.sourceId))
      .map((message) => ({ ...message, sourceId: message.sourceId }));
    watcher.seedKnownCalls(known);
    this.running.set(group, watcher);

    void watcher.watch(group, options, (event) => {
      if (this.running.get(group) !== watcher) return;
      if (event.t === "msg") {
        this.forward({ ...event, group });
        return;
      }
      if (event.t === "heartbeat") this.retryAttempts.delete(group);
      this.onStatus(event, group);
    }).catch((error: unknown) => this.handleFailure(group, watcher, error));
  }

  private forward(message: GroupMsg): void {
    const key=JSON.stringify([message.group,message.sourceId]);
    const known=!!message.sourceId&&(this.acceptedMessages.has(key)||this.knownMessageAccepted(message.group,message.sourceId));
    if (acceptsSender(this.senderFilters[message.group],message.senderId)||(!!message.messageEvent&&known)) {
      if(this.onMessage(message)!==false){
        this.acceptedMessages.add(key);
        if(this.acceptedMessages.size>10000)this.acceptedMessages.delete(this.acceptedMessages.values().next().value!);
      }
    }
    // Advance only after synchronous processing succeeds. The short overlap
    // on reconnect lets the message store deduplicate a partially committed
    // final page without replaying the group's entire original history range.
    this.lastProcessedAt.set(message.group, Math.max(this.lastProcessedAt.get(message.group) ?? 0, Number(message.time) || 0));
  }

  private handleFailure(group: string, watcher: WechatWatcher | null, error: unknown): void {
    if (watcher && this.running.get(group) !== watcher) return;
    if (!watcher && this.running.has(group)) return;
    if (watcher) this.stopGroup(group, watcher);

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[watch] ${group} stopped: ${message}`);
    this.onStatus({ t: "error", message }, group);
    if (this.stopped || !this.wantedGroups.has(group) || this.retryTimers.has(group)) return;

    const attempt = (this.retryAttempts.get(group) ?? 0) + 1;
    this.retryAttempts.set(group, attempt);
    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 5));
    const timer = setTimeout(() => {
      this.retryTimers.delete(group);
      if (!this.stopped && this.wantedGroups.has(group) && !this.running.has(group)) {
        try { this.startGroup(group); }
        catch (error) { this.handleFailure(group, null, error); }
      }
    }, wait);
    this.retryTimers.set(group, timer);
    console.error(`[watch] ${group} reconnect in ${wait}ms (attempt ${attempt})`);
  }

  private stopGroup(group: string, watcher: WechatWatcher): void {
    watcher.stop();
    if (this.running.get(group) === watcher) this.running.delete(group);
  }

  private clearRetry(group: string, timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    if (this.retryTimers.get(group) === timer) this.retryTimers.delete(group);
    this.retryAttempts.delete(group);
  }

  /** Backfill selected groups sequentially to avoid opening many duplicate shard sets. */
  backfillSince(
    sinceTs: number,
    onProgress?: (progress: BackfillScanProgress) => void,
  ): Promise<{ groups: number; messages: number }> {
    if (this.backfillPromise) return Promise.reject(new Error("微信回读已在运行"));
    const selected = [...this.wantedGroups];
    const active = selected.map((group) => [group, this.running.get(group)] as const);
    if (active.length === 0 || active.some(([, watcher]) => !watcher?.ready)) {
      const error = new Error("微信所选监听群尚未全部就绪，历史回读将在连接恢复后重试") as Error & { code?: string };
      error.code = "WECHAT_NOT_READY";
      return Promise.reject(error);
    }

    const work = this.runBackfill(active, sinceTs, onProgress);
    this.backfillPromise = work;
    return work.finally(() => {
      if (this.backfillPromise === work) this.backfillPromise = undefined;
    });
  }

  private async runBackfill(
    active: Array<[string, WechatWatcher]>,
    sinceTs: number,
    onProgress?: (progress: BackfillScanProgress) => void,
  ): Promise<{ groups: number; messages: number }> {
    let messages = 0;
    let groupsCompleted = 0;

    for (const [index, [group, watcher]] of active.entries()) {
      let lastProgressAt = 0;
      const relay = (tick: BackfillScanTick) => {
        const now = Date.now();
        if (tick.phase === "read" && tick.scanned > 0 && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        onProgress?.({
          group,
          phase: tick.phase,
          scanned: tick.scanned,
          total: tick.total,
          messages: messages + tick.messages,
          groupsCompleted,
          groupsTotal: active.length,
        });
      };

      relay({ phase: "read", scanned: 0, total: null, messages: 0 });
      const count = await watcher.backfillSince(sinceTs, (event) => {
        if (this.running.get(group) === watcher && event.t === "msg") {
          this.forward({ ...event, group });
        }
      }, relay);
      messages += count;
      groupsCompleted = index + 1;
      onProgress?.({
        group,
        phase: "done",
        scanned: count,
        total: count,
        messages,
        groupsCompleted,
        groupsTotal: active.length,
      });
    }

    return { groups: active.length, messages };
  }

  stop(): void {
    this.stopped = true;
    this.wantedGroups.clear();
    this.startOptions.clear();
    this.lastProcessedAt.clear();
    for (const [group, timer] of this.retryTimers) this.clearRetry(group, timer);
    for (const [group, watcher] of this.running) this.stopGroup(group, watcher);
    this.lookupReader?.stop();
  }
}
