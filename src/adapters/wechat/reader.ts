import crypto from "node:crypto";
import type { Database as DB } from "better-sqlite3-multiple-ciphers";
import { loadKeys, messageDbKeys, resolveDb, type DbKey, type KeyStore } from "../keys.js";
import { hasTable, openDb } from "../db.js";
import { decompressContent } from "../zstd.js";
import { displayText, extractAddresses, isBotCard } from "./extract.js";
import type { DecodedWechatMessage, WechatConversation } from "./types.js";

const MESSAGE_LABELS: Record<number, string> = {
  1: "文本", 3: "图片", 34: "语音", 42: "名片", 43: "视频", 47: "表情",
  48: "位置", 49: "链接/文件", 50: "通话", 10000: "系统", 10002: "撤回",
};
const HIDDEN_CONTEXT_TYPES = new Set([50, 10000, 10002]);
const CONTACT_DATABASE = "contact/contact.db";
const SESSION_DATABASE = "session/session.db";
const SESSION_TABLE = "SessionTable";
const NAME_TABLE = "Name2Id";
const MESSAGE_TABLE_PREFIX = "Msg_";
const MESSAGE_FIELDS = "local_id, local_type, create_time, real_sender_id, message_content, WCDB_CT_message_content";
const GROUP_SUFFIX = "@chatroom";

export interface WechatMessageShard {
  db: DB;
  table: string;
  maxCreateTime: number;
  /** Opaque digest of the shard's key entry; a re-extracted key for this file changes it. */
  keyId?: string;
}

interface ShardReader {
  db: DB;
  table: string;
  name2id: Map<number, string>;
}

interface StoredMessage {
  local_id: number;
  local_type: number | bigint;
  create_time: number;
  real_sender_id: number | null;
  message_content: unknown;
  WCDB_CT_message_content: number | null;
}

interface ContextMessage extends StoredMessage {
  shardName: string;
  name2id: Map<number, string>;
}

interface ContactRow {
  username: string;
  nick_name: string | null;
  remark: string | null;
}

interface SessionRow {
  username: string;
  unread_count: number | null;
  summary: unknown;
  last_timestamp: number;
}

/** WeChat's local message type packs the base message kind in its low 32 bits. */
export function baseType(value: number | bigint): number {
  if (typeof value === "number" && !Number.isFinite(value)) return 0;
  const word = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  return Number(BigInt.asUintN(32, word));
}

/** Stable opaque identity: callers can match a message without learning its local file path. */
export function wechatMessageSourceId(dbName: string, localId: number): string {
  const shardKey = crypto.createHash("sha256").update(dbName, "utf8").digest("hex").slice(0, 16);
  return `${shardKey}:${localId}`;
}

function contactName(row: ContactRow): string {
  return row.remark?.trim() || row.nick_name?.trim() || row.username;
}

function isGroupConversation(username: string): boolean {
  return username.endsWith(GROUP_SUFFIX);
}

function localMessageTable(username: string): string {
  return `${MESSAGE_TABLE_PREFIX}${crypto.createHash("md5").update(username, "utf8").digest("hex")}`;
}

function sourceLocalId(sourceId: string): number | null {
  const match = /^([a-f\d]{16}):(\d+)$/i.exec(sourceId);
  if (!match) return null;
  const value = Number(match[2]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timelineOrder(a: ContextMessage, b: ContextMessage): number {
  return a.create_time - b.create_time || a.local_id - b.local_id || a.shardName.localeCompare(b.shardName);
}

function safeLimit(value: number, fallback: number, ceiling: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(ceiling, Math.max(0, Math.floor(value)));
}

/** Read-only facade over WeChat's encrypted local store. It never persists decoded chat text. */
export class WechatReader {
  private store: KeyStore = loadKeys();
  private contactsSnapshot: Map<string, string> | null = null;
  private nextKeyRefreshAt = 0;
  private storeFingerprint = keyStoreFingerprint(this.store);
  protected keyRevision = 0;

  protected refreshKeys(force = false): void {
    if (!force && Date.now() < this.nextKeyRefreshAt) return;
    this.nextKeyRefreshAt = Date.now() + 2_500;

    const candidate = loadKeys();
    const currentFiles = [...this.store.byRel.keys()];
    const missingExistingKey = candidate.dbDir === this.store.dbDir &&
      currentFiles.some((relativePath) => !candidate.byRel.has(relativePath));
    if (missingExistingKey) {
      throw new Error("新密钥配置缺少原有数据库条目，继续保留已有监听；请重新完整提取密钥。");
    }

    const fingerprint = keyStoreFingerprint(candidate);
    if (fingerprint === this.storeFingerprint) return;
    this.store = candidate;
    this.storeFingerprint = fingerprint;
    this.contactsSnapshot = null;
    this.keyRevision++;
  }

  private contacts(): Map<string, string> {
    this.refreshKeys();
    if (this.contactsSnapshot) return this.contactsSnapshot;

    const byUsername = new Map<string, string>();
    const db = openDb(this.store, CONTACT_DATABASE);
    if (db) {
      try {
        const rows = db.prepare("SELECT username, nick_name, remark FROM contact").all() as ContactRow[];
        for (const row of rows) if (row.username) byUsername.set(row.username, contactName(row));
      } catch {
        // Some WeChat builds use a different contact schema. Keep raw usernames available.
      } finally {
        db.close();
      }
    }
    this.contactsSnapshot = byUsername;
    return byUsername;
  }

  display(username: string): string {
    return this.contacts().get(username) || username;
  }

  listSessions(limit = 50): WechatConversation[] {
    this.refreshKeys();
    const db = openDb(this.store, SESSION_DATABASE);
    if (!db) throw new Error("无法解密 session/session.db（缺少密钥？）");

    try {
      const count = safeLimit(limit, 50, 500);
      const rows = db.prepare(
        `SELECT username, unread_count, summary, last_timestamp
           FROM ${SESSION_TABLE}
          WHERE last_timestamp > 0
          ORDER BY last_timestamp DESC
          LIMIT ?`,
      ).all(count) as SessionRow[];
      const names = this.contacts();
      return rows.map((row) => {
        let summary = decompressContent(row.summary, 4) ?? "";
        if (isGroupConversation(row.username)) summary = removeGroupSenderPrefix(summary);
        return {
          username: row.username,
          displayName: names.get(row.username) || row.username,
          isGroup: isGroupConversation(row.username),
          unread: row.unread_count ?? 0,
          lastTimestamp: row.last_timestamp,
          summary: summary.replace(/\s+/g, " ").trim(),
        };
      });
    } finally {
      db.close();
    }
  }

  listGroups(limit = 100): WechatConversation[] {
    return this.listSessions(safeLimit(limit, 100, 500)).filter((session) => session.isGroup);
  }

  resolveTarget(query: string): string | null {
    const requested = query.trim();
    if (!requested) return null;
    const lowered = requested.toLocaleLowerCase();
    const names = this.contacts();

    for (const [username, displayName] of names) {
      if (displayName.toLocaleLowerCase() === lowered) return username;
    }
    for (const [username, displayName] of names) {
      if (displayName.toLocaleLowerCase().includes(lowered)) return username;
    }
    if (names.has(requested)) return requested;
    return isRawWechatUsername(requested) ? requested : null;
  }

  protected findMessageShards(username: string, skip?: (absPath: string, keyId: string) => boolean): WechatMessageShard[] {
    this.refreshKeys(true);
    const table = localMessageTable(username);
    if (!/^Msg_[0-9a-f]{32}$/.test(table)) return [];

    const found: WechatMessageShard[] = [];
    try {
      for (const key of messageDbKeys(this.store)) {
        const keyId = shardKeyId(key);
        if (skip?.(resolveDb(this.store, key.rel)?.absPath ?? "", keyId)) continue;
        const db = openDb(this.store, key.rel);
        if (!db) continue;
        try {
          if (!hasTable(db, table)) {
            db.close();
            continue;
          }
          // sort_seq (= create_time * 1000) is indexed; MAX(create_time) scanned the whole table on every refresh.
          const summary = db.prepare(`SELECT MAX(sort_seq) AS latest FROM [${table}]`).get() as { latest: number | bigint | null };
          found.push({ db, table, maxCreateTime: summary?.latest == null ? 0 : Math.floor(Number(summary.latest) / 1_000), keyId });
        } catch (error) {
          db.close();
          throw error;
        }
      }
    } catch (error) {
      closeShards(found);
      throw error;
    }
    found.sort((a, b) => b.maxCreateTime - a.maxCreateTime || a.db.name.localeCompare(b.db.name));
    return found;
  }

  readAround(
    username: string,
    timestamp: number,
    before: number,
    after: number,
    sourceId?: string,
  ): DecodedWechatMessage[] {
    const opened = this.findMessageShards(username);
    try {
      const shards = opened.map((shard) => ({
        db: shard.db,
        table: shard.table,
        name2id: this.loadName2Id(shard.db),
      }));
      return this.readAroundIn(shards, username, timestamp, before, after, sourceId);
    } finally {
      closeShards(opened);
    }
  }

  readRange(username: string, from: number, to: number, limit = 5_000): DecodedWechatMessage[] {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
    const maxRows = safeLimit(limit, 5_000, 50_000);
    if (maxRows === 0) return [];

    const opened = this.findMessageShards(username);
    try {
      const group = isGroupConversation(username);
      const all: Array<{ message: DecodedWechatMessage; localId: number; shard: string }> = [];
      for (const shard of opened) {
        const name2id = this.loadName2Id(shard.db);
        const rows = shard.db.prepare(
          `SELECT ${MESSAGE_FIELDS}
             FROM [${shard.table}]
            WHERE sort_seq >= ? AND sort_seq < ?
            ORDER BY sort_seq ASC, local_id ASC
            LIMIT ?`,
        ).all(Math.floor(from) * 1_000, (Math.floor(to) + 1) * 1_000, maxRows) as StoredMessage[];
        for (const row of rows) {
          const kind = baseType(row.local_type);
          if (HIDDEN_CONTEXT_TYPES.has(kind)) continue;
          all.push({
            message: this.decodeMessage(shard.db.name, name2id, username, group, row),
            localId: row.local_id,
            shard: shard.db.name,
          });
        }
      }
      all.sort((a, b) => a.message.createTime - b.message.createTime || a.localId - b.localId || a.shard.localeCompare(b.shard));
      return all.slice(0, maxRows).map(({ message }) => message);
    } finally {
      closeShards(opened);
    }
  }

  protected readAroundIn(
    shards: ShardReader[],
    username: string,
    timestamp: number,
    before: number,
    after: number,
    sourceId?: string,
  ): DecodedWechatMessage[] {
    if (!Number.isFinite(timestamp)) return [];
    const beforeCount = safeLimit(before, 0, 500);
    const afterCount = safeLimit(after, 0, 500);
    const group = isGroupConversation(username);
    const target = this.findTargetMessage(shards, sourceId);
    const pivotTime = target?.create_time ?? Math.floor(timestamp);
    const pivotId = target?.local_id ?? -1;
    const beforeRows: ContextMessage[] = [];
    const afterRows: ContextMessage[] = [];
    const fetchBefore = beforeCount + 16;
    const fetchAfter = afterCount + 16;

    for (const shard of shards) {
      const previousRows = target
        ? shard.db.prepare(
          `SELECT ${MESSAGE_FIELDS} FROM [${shard.table}]
            WHERE sort_seq <= ? AND (sort_seq < ? OR local_id < ?)
            ORDER BY sort_seq DESC, local_id DESC LIMIT ?`,
        ).all(pivotTime * 1_000, pivotTime * 1_000, pivotId, fetchBefore) as StoredMessage[]
        : shard.db.prepare(
          `SELECT ${MESSAGE_FIELDS} FROM [${shard.table}]
            WHERE sort_seq < ? ORDER BY sort_seq DESC, local_id DESC LIMIT ?`,
        ).all((pivotTime + 1) * 1_000, fetchBefore) as StoredMessage[];
      const followingRows = target
        ? shard.db.prepare(
          `SELECT ${MESSAGE_FIELDS} FROM [${shard.table}]
            WHERE sort_seq >= ? AND (sort_seq > ? OR local_id > ?)
            ORDER BY sort_seq ASC, local_id ASC LIMIT ?`,
        ).all(pivotTime * 1_000, pivotTime * 1_000, pivotId, fetchAfter) as StoredMessage[]
        : shard.db.prepare(
          `SELECT ${MESSAGE_FIELDS} FROM [${shard.table}]
            WHERE sort_seq >= ? ORDER BY sort_seq ASC, local_id ASC LIMIT ?`,
        ).all((pivotTime + 1) * 1_000, fetchAfter) as StoredMessage[];

      for (const row of previousRows) beforeRows.push(this.withShard(shard, row));
      for (const row of followingRows) afterRows.push(this.withShard(shard, row));
    }

    beforeRows.sort((a, b) => timelineOrder(b, a));
    afterRows.sort(timelineOrder);
    const beforeSelection = beforeRows.filter((row) => !HIDDEN_CONTEXT_TYPES.has(baseType(row.local_type))).slice(0, beforeCount).reverse();
    const afterSelection = afterRows.filter((row) => !HIDDEN_CONTEXT_TYPES.has(baseType(row.local_type))).slice(0, afterCount);
    const selected = target
      ? [...beforeSelection, target, ...afterSelection]
      : [...beforeSelection, ...afterSelection];

    return selected.map((row) => this.decodeMessage(
      row.shardName, row.name2id, username, group, row,
    ));
  }

  protected loadName2Id(db: DB): Map<number, string> {
    const mapping = new Map<number, string>();
    try {
      const rows = db.prepare(`SELECT rowid, user_name FROM ${NAME_TABLE}`).all() as Array<{ rowid: number; user_name: string | null }>;
      for (const row of rows) if (row.user_name) mapping.set(row.rowid, row.user_name);
    } catch {
      // The message's sender prefix is used when this auxiliary table is absent.
    }
    return mapping;
  }

  protected formatContent(
    content: string,
    kind: number,
    group: boolean,
    chatUsername: string,
    realSenderId: number | null,
    name2id: Map<number, string>,
  ): { sender: string; senderId?: string; text: string } {
    const senderFromContent = group ? groupSender(content) : "";
    const senderUsername = (realSenderId !== null ? name2id.get(realSenderId) : undefined) || senderFromContent;
    const visibleSender = senderUsername && senderUsername !== chatUsername ? this.display(senderUsername) : "";
    const visibleSenderId = senderUsername && senderUsername !== chatUsername ? senderUsername : undefined;
    const body = group && content.includes(":\n") ? content.slice(content.indexOf(":\n") + 2) : content;
    if (kind === 1) return { sender: visibleSender, senderId: visibleSenderId, text: body };

    const label = MESSAGE_LABELS[kind] ?? `type=${kind}`;
    const maxBodyLength = kind === 49 ? 8_000 : 200;
    const text = body.trim() ? `[${label}] ${body.trim().slice(0, maxBodyLength)}` : `[${label}]`;
    return { sender: visibleSender, senderId: visibleSenderId, text };
  }

  private decodeMessage(
    shardName: string,
    name2id: Map<number, string>,
    username: string,
    group: boolean,
    row: StoredMessage,
  ): DecodedWechatMessage {
    const kind = baseType(row.local_type);
    const content = decompressContent(row.message_content, row.WCDB_CT_message_content) ?? "";
    const formatted = this.formatContent(content, kind, group, username, row.real_sender_id, name2id);
    const rawBody = group ? removeGroupSenderPrefix(content) : content;
    const forAddressScan = kind === 49 ? rawBody : formatted.text;
    const { addrs, chainHint } = extractAddresses(forAddressScan, kind);
    const visibleText = kind === 1 || kind === 49
      ? displayText(formatted.text, kind)
      : `[${MESSAGE_LABELS[kind] ?? `type=${kind}`}]`;
    return {
      createTime: row.create_time,
      sourceId: wechatMessageSourceId(shardName, row.local_id),
      senderId: formatted.senderId,
      sender: formatted.sender,
      text: visibleText.slice(0, isBotCard(visibleText) ? 1_200 : 200),
      addrs,
      chainHint,
    };
  }

  private withShard(shard: ShardReader, row: StoredMessage): ContextMessage {
    return { ...row, shardName: shard.db.name, name2id: shard.name2id };
  }

  private findTargetMessage(shards: ShardReader[], sourceId?: string): ContextMessage | undefined {
    if (!sourceId) return undefined;
    const localId = sourceLocalId(sourceId);
    if (localId === null) return undefined;
    for (const shard of shards) {
      if (wechatMessageSourceId(shard.db.name, localId) !== sourceId) continue;
      const row = shard.db.prepare(`SELECT ${MESSAGE_FIELDS} FROM [${shard.table}] WHERE local_id=? LIMIT 1`).get(localId) as StoredMessage | undefined;
      if (row) return this.withShard(shard, row);
    }
    return undefined;
  }

}

function shardKeyId(key: DbKey): string {
  return crypto.createHash("sha256").update(`${key.rel}:${key.encKeyHex}:${key.salt}`, "utf8").digest("hex").slice(0, 16);
}

function keyStoreFingerprint(store: KeyStore): string {
  const entries = [...store.byRel].sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, key]) => [relativePath, key.encKeyHex, key.salt]);
  return JSON.stringify([store.dbDir, entries]);
}

function closeShards(shards: Array<{ db: DB }>): void {
  for (const shard of shards) {
    try { shard.db.close(); } catch { /* a failed connection may already be closed */ }
  }
}

function removeGroupSenderPrefix(content: string): string {
  const separator = content.indexOf(":\n");
  return separator < 0 ? content : content.slice(separator + 2);
}

function groupSender(content: string): string {
  const separator = content.indexOf(":\n");
  return separator < 0 ? "" : content.slice(0, separator);
}

function isRawWechatUsername(value: string): boolean {
  return value.endsWith(GROUP_SUFFIX) || value.startsWith("wxid_") || value.startsWith("gh_");
}
