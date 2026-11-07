import fs from "node:fs";
import type { Database as DB } from "better-sqlite3-multiple-ciphers";
import { WechatReader, baseType, wechatMessageSourceId, type WechatMessageShard } from "./reader.js";
import type { DecodedWechatMessage } from "./types.js";
import { decompressContent } from "../zstd.js";
import { displayText, extractAddresses } from "./extract.js";

export type WatchEvent =
  | {
      t: "msg";
      time: number;
      sourceId: string;
      messageEvent?: "edit" | "delete" | "retract";
      messageRevision?: number;
      sender: string;
      senderId?: string;
      text: string;
      addrs: string[];
      chainHint: string | null;
      backfill: boolean;
    }
  | { t: "heartbeat"; maxTime: number; polls: number }
  | { t: "error"; message: string };

export type BackfillScanTick = {
  phase: "read" | "process" | "done";
  scanned: number;
  total: number | null;
  messages: number;
};

const POLL_INTERVAL_MS = boundedEnv("FOMOMO_WECHAT_POLL_MS", 300, 100, 2_500);
const HEARTBEAT_INTERVAL_MS = 10_000;
const LIVE_PAGE_SIZE = 500;
const BACKFILL_PAGE_SIZE = 100;
const PAGES_PER_TURN = 8;
const RECONCILE_BATCH_SIZE = 20;
const MAX_TRACKED_CALLS_PER_SHARD = 5_000;
const MESSAGE_COLUMNS = "local_id, local_type, create_time, real_sender_id, message_content, WCDB_CT_message_content";
const RECALL_XML = /<sysmsg\b[^>]*\btype\s*=\s*["']revokemsg["'][^>]*>[\s\S]*?<revokemsg\b/i;

interface Cursor {
  db: DB;
  table: string;
  name2id: Map<number, string>;
  cursorTime: number;
  cursorId: number;
  arrivalId?: number;
  serverIdColumn?: string;
  /** File identity at open time; a different value means WeChat replaced the database file. */
  fileId?: string;
  keyId?: string;
  /** Sender ids missing from Name2Id; retried after the next periodic refresh. */
  missingSenders?: Set<number>;
}

interface StoredMessage {
  local_id: number;
  local_type: number | bigint;
  create_time: number;
  real_sender_id: number | null;
  message_content: unknown;
  WCDB_CT_message_content: number | null;
  server_id?: number | string | null;
}

interface TrackedCall {
  event: Extract<WatchEvent, { t: "msg" }>;
  raw: string;
}

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** WeChat represents retractions as system messages and replaces old rows on some builds. */
export function isWechatRecall(type: number, content: string): boolean {
  return type === 10002 || (type === 10000 && RECALL_XML.test(content));
}

/** Keep the per-shard cursor when a database is reopened; new shards start at the requested time. */
export function restoreShardCursors<T extends { db: { name: string }; cursorTime: number; cursorId: number; arrivalId?: number; fileId?: string }>(
  fresh: T[],
  previous: ReadonlyArray<{ db: { name: string }; cursorTime: number; cursorId: number; arrivalId?: number; fileId?: string }>,
  baselineTime: number,
): T[] {
  const cursors = new Map(previous.map((shard) => [shard.db.name, shard]));
  return fresh.map((shard) => {
    const previousCursor = cursors.get(shard.db.name);
    return previousCursor
      ? (previousCursor.fileId && shard.fileId && previousCursor.fileId !== shard.fileId
        ? {...shard,cursorTime:Math.min(baselineTime,Math.floor(Date.now()/1000)-86400),cursorId:-1}
        : { ...shard, cursorTime: previousCursor.cursorTime, cursorId: previousCursor.cursorId, ...(previousCursor.arrivalId!==undefined?{arrivalId:previousCursor.arrivalId}:{}) })
      : { ...shard, cursorTime: baselineTime, cursorId: -1 };
  });
}

/**
 * Polls WeChat's encrypted message shards using one independent cursor per shard.
 * History scans use separate read-only handles and never move the live cursors.
 */
export class WechatWatcher extends WechatReader {
  private shards: Cursor[] = [];
  private runningUsername = "";
  private polls = 0;
  private lastReadAt = 0;
  private latestMessageAt = 0;
  private stopped = false;
  private seededShardNames = new Set<string>();
  private seededCalls: Extract<WatchEvent, { t: "msg" }>[] = [];
  private trackedCalls = new Map<string, Map<number, TrackedCall>>();
  private reconcileOffsets = new Map<string, number>();

  get ready(): boolean {
    return !this.stopped && this.shards.length > 0 && this.lastReadAt > 0 && Date.now() - this.lastReadAt < 30_000 && !this.health().staleDatabase;
  }

  health() {
    let updatedAt = 0;
    for (const shard of this.shards) for (const name of [shard.db.name, shard.db.name + '-wal']) {
      try { updatedAt = Math.max(updatedAt, fs.statSync(name).mtimeMs); } catch {}
    }
    return { lastReadAt: Math.floor(this.lastReadAt / 1000), latestMessageAt: this.latestMessageAt,
      polls: this.polls, databaseUpdatedAt: Math.floor(updatedAt / 1000),
      staleDatabase: updatedAt > 0 && Date.now() - updatedAt > 24 * 3600_000 };
  }

  seedKnownCalls(messages: Extract<WatchEvent, { t: "msg" }>[]): void {
    this.seededCalls = messages.slice(-MAX_TRACKED_CALLS_PER_SHARD);
  }

  override readAround(
    username: string,
    timestamp: number,
    before: number,
    after: number,
    sourceId?: string,
  ): DecodedWechatMessage[] {
    if (this.shards.length === 0 || username !== this.runningUsername) {
      return super.readAround(username, timestamp, before, after, sourceId);
    }
    return this.readAroundIn(this.shards, username, timestamp, before, after, sourceId);
  }

  stop(): void {
    this.stopped = true;
  }

  private openShards(username: string, baselineTime: number, preserveCursors: boolean): void {
    const opened = this.findMessageShards(username);
    let fresh: Cursor[];
    try {
      fresh = opened.map((shard) => this.toCursor(shard, baselineTime));
    } catch (error) {
      closeDatabases(opened);
      throw error;
    }

    const next = preserveCursors
      ? restoreShardCursors(fresh, this.shards, baselineTime)
      : fresh;
    this.closeShards();
    this.shards = next;
  }

  private toCursor(shard: WechatMessageShard, baselineTime: number): Cursor {
    this.latestMessageAt = Math.max(this.latestMessageAt, shard.maxCreateTime);
    return {
      db: shard.db,
      table: shard.table,
      name2id: this.loadName2Id(shard.db),
      cursorTime: baselineTime,
      cursorId: -1,
      arrivalId: Number((shard.db.prepare(`SELECT MAX(local_id) id FROM [${shard.table}]`).get() as { id: number | null }).id ?? 0),
      serverIdColumn: this.findServerIdColumn(shard),
      fileId: fileIdentity(shard.db.name),
      keyId: shard.keyId,
    };
  }

  /**
   * Periodic refresh (fomomo's REOPEN_EVERY approach): open handles stay open and keep reading new rows via sort_seq.
   * Only shards that newly appeared, whose file was replaced on disk, or whose key entry changed are (re)opened.
   */
  private refreshShards(username: string, baselineTime: number): void {
    const candidates = new Map<string, Cursor>();
    for (const shard of this.shards) {
      shard.missingSenders?.clear();
      const id = fileIdentity(shard.db.name);
      if (id && id === shard.fileId) candidates.set(shard.db.name, shard);
    }
    // findMessageShards reloads the key store first; a shard stays open only while it is still listed with the same key.
    const kept = new Map<string, Cursor>();
    const opened = this.findMessageShards(username, (absPath, keyId) => {
      const shard = candidates.get(absPath);
      if (!shard || shard.keyId !== keyId) return false;
      kept.set(absPath, shard);
      return true;
    });
    let added: Cursor[];
    try {
      added = opened.map((shard) => this.toCursor(shard, baselineTime));
    } catch (error) {
      closeDatabases(opened);
      throw error;
    }
    const stale = this.shards.filter((shard) => !kept.has(shard.db.name));
    if (added.length === 0 && stale.length === 0) return;
    this.shards = [...kept.values(), ...added.map(shard => {
      const previous=this.shards.find(old=>old.db.name===shard.db.name&&old.fileId===shard.fileId);
      return previous?{...shard,cursorTime:previous.cursorTime,cursorId:previous.cursorId,arrivalId:previous.arrivalId??shard.arrivalId}:
        {...shard,cursorTime:Math.min(baselineTime,Math.floor(Date.now()/1000)-86400),cursorId:-1};
    })];
    closeDatabases(stale);
    console.error(`[watch] ${username} shards=${this.shards.length} opened=${added.length} closed=${stale.length}`);
  }

  /** Name2Id only grows: resolve a sender that appeared after the shard was opened with one rowid lookup. */
  private ensureSender(shard: Cursor, senderId: number | null): void {
    if (senderId === null || shard.name2id.has(senderId) || shard.missingSenders?.has(senderId)) return;
    try {
      const row = shard.db.prepare("SELECT user_name FROM Name2Id WHERE rowid=?").get(senderId) as { user_name: string | null } | undefined;
      if (row?.user_name) {
        shard.name2id.set(senderId, row.user_name);
        return;
      }
    } catch {
      // Name2Id may be absent on some builds; the sender prefix in the message is used instead.
    }
    (shard.missingSenders ??= new Set()).add(senderId);
  }

  private findServerIdColumn(shard: WechatMessageShard): string | undefined {
    try {
      const columns = shard.db.prepare(`PRAGMA table_info([${shard.table}])`).all() as Array<{ name: string }>;
      return columns.find((column) => ["server_id", "msg_svr_id", "msgSvrId"].includes(column.name))?.name;
    } catch {
      return undefined;
    }
  }

  private recentCursor(count: number): number {
    const limit = Math.max(0, Math.min(50_000, Math.floor(count)));
    if (limit === 0) return Math.floor(Date.now() / 1_000);

    const sequences: number[] = [];
    for (const shard of this.shards) {
      const rows = shard.db.prepare(
        `SELECT sort_seq FROM [${shard.table}] ORDER BY sort_seq DESC LIMIT ?`,
      ).all(limit) as Array<{ sort_seq: number | bigint }>;
      for (const row of rows) sequences.push(Number(row.sort_seq));
    }
    if (sequences.length < limit) return 0;
    sequences.sort((left, right) => right - left);
    return Math.floor(sequences[limit - 1] / 1_000);
  }

  private closeShards(): void {
    closeDatabases(this.shards);
    this.shards = [];
  }

  private emitRecallForOriginal(
    shard: Cursor,
    recallRow: StoredMessage,
    xml: string,
    emit: (event: WatchEvent) => void,
    backfill: boolean,
  ): void {
    const serverId = xml.match(/<(?:newmsgid|msgsvrid)>(?:<!\[CDATA\[)?(\d+)/i)?.[1];
    if (!serverId || !shard.serverIdColumn) return;

    const original = shard.db.prepare(
      `SELECT local_id FROM [${shard.table}] WHERE [${shard.serverIdColumn}]=? LIMIT 1`,
    ).get(serverId) as { local_id: number } | undefined;
    if (!original) return;

    emit({
      t: "msg",
      messageEvent: "retract",
      time: recallRow.create_time,
      messageRevision: this.nextRevision(this.trackedCalls.get(shard.db.name)?.get(original.local_id)?.event ?? {t:"msg",time:recallRow.create_time,sourceId:"",sender:"",text:"",addrs:[],chainHint:null,backfill}),
      sourceId: wechatMessageSourceId(shard.db.name, original.local_id),
      sender: "",
      text: "",
      addrs: [],
      chainHint: null,
      backfill,
    });
  }

  private trackCall(shard: Cursor, message: Extract<WatchEvent, { t: "msg" }>, raw: string): void {
    let calls = this.trackedCalls.get(shard.db.name);
    if (!calls) {
      calls = new Map();
      this.trackedCalls.set(shard.db.name, calls);
    }
    calls.set(Number(message.sourceId.slice(message.sourceId.lastIndexOf(":") + 1)), { event: message, raw });
    while (calls.size > MAX_TRACKED_CALLS_PER_SHARD) {
      const oldest = calls.keys().next().value;
      if (oldest === undefined) break;
      calls.delete(oldest);
    }
  }

  private seedShardCalls(shard: Cursor): Map<number, TrackedCall> {
    let calls = this.trackedCalls.get(shard.db.name);
    if (!calls) {
      calls = new Map();
      this.trackedCalls.set(shard.db.name, calls);
    }
    if (this.seededShardNames.has(shard.db.name)) return calls;

    this.seededShardNames.add(shard.db.name);
    const prefix = `${wechatMessageSourceId(shard.db.name, 0).split(":")[0]}:`;
    for (const event of this.seededCalls) {
      if (!event.sourceId.startsWith(prefix)) continue;
      const localId = Number(event.sourceId.slice(prefix.length));
      if (!Number.isSafeInteger(localId) || localId < 0 || calls.has(localId)) continue;
      calls.set(localId, { event: { ...event }, raw: "\0" });
    }
    while (calls.size > MAX_TRACKED_CALLS_PER_SHARD) {
      const oldest = calls.keys().next().value;
      if (oldest === undefined) break;
      calls.delete(oldest);
    }
    return calls;
  }

  private reconcileTrackedCalls(
    shard: Cursor,
    group: boolean,
    username: string,
    emit: (event: WatchEvent) => void,
  ): void {
    const calls = this.seedShardCalls(shard);
    if (calls.size === 0) return;

    const ids = [...calls.keys()];
    const offset = this.reconcileOffsets.get(shard.db.name) ?? 0;
    const batch = ids.slice(offset, offset + RECONCILE_BATCH_SIZE);
    if (batch.length === 0) return;
    const placeholders = batch.map(() => "?").join(",");
    const rows = shard.db.prepare(
      `SELECT local_id, local_type, create_time, real_sender_id, message_content, WCDB_CT_message_content
         FROM [${shard.table}] WHERE local_id IN (${placeholders})`,
    ).all(...batch) as StoredMessage[];
    const rowsById = new Map(rows.map((row) => [row.local_id, row]));

    for (const localId of batch) {
      const previous = calls.get(localId);
      if (!previous) continue;
      const row = rowsById.get(localId);
      if (!row) {
        emit({ ...previous.event, messageEvent: "delete", messageRevision: this.nextRevision(previous.event), addrs: [], chainHint: null, backfill: false });
        calls.delete(localId);
        continue;
      }

      const type = baseType(row.local_type);
      const content = decompressContent(row.message_content, row.WCDB_CT_message_content) ?? "";
      if (isWechatRecall(type, content)) {
        emit({ ...previous.event, messageEvent: "retract", messageRevision: this.nextRevision(previous.event), addrs: [], chainHint: null, backfill: false });
        calls.delete(localId);
        continue;
      }
      if (type !== 1 && type !== 49) continue;

      this.ensureSender(shard, row.real_sender_id);
      const formatted = this.formatContent(content, type, group, username, row.real_sender_id, shard.name2id);
      const raw = group && content.includes(":\n") ? content.slice(content.indexOf(":\n") + 2) : content;
      const body = type === 49 ? raw : formatted.text;
      if (body === previous.raw) continue;

      const visibleText = displayText(body, type).slice(0, 300);
      const { addrs, chainHint } = extractAddresses(body, type);
      const sameAddresses=addrs.length===previous.event.addrs.length&&addrs.every(a=>previous.event.addrs.includes(a));
      if (previous.raw === "\0" && visibleText === previous.event.text && sameAddresses && chainHint===previous.event.chainHint) {
        calls.set(localId, { ...previous, raw: body });
        continue;
      }
      const updated = {
        ...previous.event,
        messageEvent: "edit" as const,
        messageRevision: this.nextRevision(previous.event),
        text: visibleText,
        addrs,
        chainHint,
        backfill: false,
      };
      emit(updated);
      calls.set(localId, { event: updated, raw: body });
    }

    this.reconcileOffsets.set(
      shard.db.name,
      offset + batch.length >= ids.length ? 0 : offset + batch.length,
    );
  }

  private nextRevision(event: Extract<WatchEvent, { t: "msg" }>): number {
    return Math.max(Date.now(), Number(event.messageRevision ?? event.time * 1000) + 1);
  }

  private emitRow(shard: Cursor, row: StoredMessage, group: boolean, username: string,
    emit: (event: WatchEvent) => void, startedAt: number, backfill: boolean): void {
      const type = baseType(row.local_type);
      const content = decompressContent(row.message_content, row.WCDB_CT_message_content) ?? "";
      if (isWechatRecall(type, content)) {
        this.emitRecallForOriginal(shard, row, content, emit, backfill);
      } else if (type === 1 || type === 49) {
        this.ensureSender(shard, row.real_sender_id);
        const formatted = this.formatContent(content, type, group, username, row.real_sender_id, shard.name2id);
        const raw = group && content.includes(":\n") ? content.slice(content.indexOf(":\n") + 2) : content;
        const body = type === 49 ? raw : formatted.text;
        const { addrs, chainHint } = extractAddresses(body, type);
        if (addrs.length > 0) {
          const event: Extract<WatchEvent, { t: "msg" }> = {
            t: "msg",
            time: row.create_time,
            detectedAtMs: Date.now(),
            sourceId: wechatMessageSourceId(shard.db.name, row.local_id),
            sender: formatted.sender,
            senderId: formatted.senderId,
            text: displayText(body, type).slice(0, 300),
            addrs,
            chainHint,
            backfill: backfill || row.create_time < startedAt,
          };
          emit(event);
          this.trackCall(shard, event, body);
        }
      }

  }

  /** New local ids catch delayed database writes even when their message timestamp is behind the time cursor. */
  private readArrivals(shard: Cursor, group: boolean, username: string,
    emit: (event: WatchEvent) => void, startedAt: number): void {
    if(shard.arrivalId===undefined)return;
    const rows=shard.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM [${shard.table}]
      WHERE local_id>? ORDER BY local_id LIMIT ${BACKFILL_PAGE_SIZE}`).all(shard.arrivalId) as StoredMessage[];
    const cutoff=Math.floor(Date.now()/1000)-86400;
    for(const row of rows){
      if(row.create_time>=cutoff && row.create_time<=shard.cursorTime &&
        !this.trackedCalls.get(shard.db.name)?.has(row.local_id)){
        this.emitRow(shard,row,group,username,emit,startedAt,false);
      }
      // A failed delivery leaves this id uncommitted for the next poll.
      shard.arrivalId=row.local_id;
    }
  }

  private readPage(
    shard: Cursor,
    group: boolean,
    username: string,
    emit: (event: WatchEvent) => void,
    startedAt: number,
    upperBound?: number,
    backfill = false,
    onScanned?: (count: number) => void,
  ): { scanned: number; maxTime: number } {
    const pageSize = backfill ? BACKFILL_PAGE_SIZE : LIVE_PAGE_SIZE;
    const cursorSequence = shard.cursorTime * 1_000;
    const upperClause = upperBound === undefined ? "" : " AND sort_seq < ?";
    const params = upperBound === undefined
      ? [cursorSequence, cursorSequence, shard.cursorId]
      : [cursorSequence, cursorSequence, shard.cursorId, upperBound * 1_000];
    const rows = shard.db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM [${shard.table}]
        WHERE sort_seq >= ? AND (sort_seq > ? OR local_id > ?)${upperClause}
        ORDER BY sort_seq ASC, local_id ASC LIMIT ${pageSize}`,
    ).all(...params) as StoredMessage[];

    let maxTime = shard.cursorTime;
    for (const row of rows) {
      this.emitRow(shard,row,group,username,emit,startedAt,backfill);

      // Advance only after decode and event delivery succeed, so a failed callback is replayed.
      shard.cursorTime = row.create_time;
      shard.cursorId = row.local_id;
      maxTime = Math.max(maxTime, row.create_time);
      this.latestMessageAt = Math.max(this.latestMessageAt, row.create_time);
    }

    if (!backfill) this.reconcileTrackedCalls(shard, group, username, emit);
    if (rows.length > 0) onScanned?.(rows.length);
    return { scanned: rows.length, maxTime };
  }

  private async drainLiveShard(
    shard: Cursor,
    group: boolean,
    username: string,
    emit: (event: WatchEvent) => void,
    startedAt: number,
  ): Promise<number> {
    let maxTime = shard.cursorTime;
    for (let page = 0; page < PAGES_PER_TURN && !this.stopped; page++) {
      const oldTime = shard.cursorTime;
      const oldId = shard.cursorId;
      maxTime = Math.max(maxTime, this.readPage(shard, group, username, emit, startedAt).maxTime);
      if (shard.cursorTime === oldTime && shard.cursorId === oldId) break;
      if (page + 1 < PAGES_PER_TURN) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.readArrivals(shard,group,username,emit,startedAt);
    return maxTime;
  }

  async backfillSince(
    sinceTime: number,
    emit: (event: WatchEvent) => void,
    onProgress?: (progress: BackfillScanTick) => void,
  ): Promise<number> {
    if (this.stopped || this.shards.length === 0) {
      const error = new Error("微信监听群尚未就绪，历史回读尚未开始") as Error & { code?: string };
      error.code = "WECHAT_NOT_READY";
      throw error;
    }
    const group = this.runningUsername.endsWith("@chatroom");
    const upperBound = Math.floor(Date.now() / 1_000) + 1;
    const baseline = Math.max(0, Math.floor(sinceTime));
    const opened = this.findMessageShards(this.runningUsername);
    let cursors: Cursor[];
    try {
      cursors = opened.map((shard) => ({
        db: shard.db,
        table: shard.table,
        name2id: this.loadName2Id(shard.db),
        cursorTime: baseline,
        cursorId: -1,
        serverIdColumn: this.findServerIdColumn(shard),
      }));
    } catch (error) {
      closeDatabases(opened);
      throw error;
    }

    let scanned = 0;
    let messages = 0;
    onProgress?.({ phase: "read", scanned, total: null, messages });
    try {
      for (const shard of cursors) {
        while (!this.stopped) {
          const oldTime = shard.cursorTime;
          const oldId = shard.cursorId;
          this.readPage(shard, group, this.runningUsername, (event) => {
            if (event.t === "msg") messages++;
            emit(event);
          }, upperBound, upperBound, true, (count) => {
            scanned += count;
            onProgress?.({ phase: "read", scanned, total: null, messages });
          });
          if (shard.cursorTime === oldTime && shard.cursorId === oldId) break;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    } finally {
      closeDatabases(cursors);
    }
    onProgress?.({ phase: "done", scanned, total: scanned, messages });
    return messages;
  }

  async watch(
    query: string,
    options: { sinceTs: number } | { lastN: number },
    emit: (event: WatchEvent) => void,
  ): Promise<void> {
    const username = this.resolveTarget(query);
    if (!username) throw new Error(`未能解析会话 "${query}"`);
    this.runningUsername = username;
    this.stopped = false;
    this.polls = 0;

    const initialTime = "sinceTs" in options ? Math.max(0, Math.floor(options.sinceTs)) : 0;
    this.openShards(username, initialTime, false);
    const sinceTime = "sinceTs" in options ? initialTime : this.recentCursor(options.lastN);
    for (const shard of this.shards) {
      shard.cursorTime = sinceTime;
      shard.cursorId = -1;
    }

    console.error(`[watch] ${username} shards=${this.shards.length} poll=${POLL_INTERVAL_MS}ms since=${sinceTime}`);
    const startedAt = Math.floor(Date.now() / 1_000);
    let latestTime = sinceTime;
    let nextRefreshAt = Date.now() + 60_000;
    let refreshFailures = 0;
    let lastHeartbeatAt = 0;

    try {
      while (!this.stopped) {
        try {
          if (Date.now() >= nextRefreshAt) {
            try {
              this.refreshShards(username, sinceTime);
              refreshFailures = 0;
              nextRefreshAt = Date.now() + 60_000;
            } catch (error) {
              const delay = Math.min(60_000, 1_000 * 2 ** Math.min(refreshFailures++, 6));
              nextRefreshAt = Date.now() + delay;
              emit({ t: "error", message: `配置刷新失败，继续读取已有分片：${errorMessage(error)}` });
            }
          }

          for (const shard of this.shards) {
            latestTime = Math.max(
              latestTime,
              await this.drainLiveShard(shard, username.endsWith("@chatroom"), username, emit, startedAt),
            );
          }
          this.lastReadAt = Date.now();
          this.polls++;
          const now = Date.now();
          if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
            lastHeartbeatAt = now;
            emit({ t: "heartbeat", maxTime: latestTime, polls: this.polls });
          }
        } catch (error) {
          emit({ t: "error", message: errorMessage(error) });
          try {
            this.openShards(username, sinceTime, true);
          } catch (reopenError) {
            console.error(`[watch] reopen failed: ${errorMessage(reopenError)}`);
          }
        }
        if (!this.stopped) await delay(POLL_INTERVAL_MS);
      }
    } finally {
      this.closeShards();
    }
  }
}

function closeDatabases(shards: Array<{ db: DB }>): void {
  for (const shard of shards) {
    try { shard.db.close(); } catch { /* connection may already be closed */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Identity of a shard file; it changes when WeChat replaces the database file instead of updating it. */
function fileIdentity(file: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch {
    return "";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
