import fs from "node:fs";
import path from "node:path";
import {
  HttpProxyTcpTransport,
  networkMiddlewares,
  SqliteStorage,
  TelegramClient,
} from "@mtcute/node";
import type { Message, User } from "@mtcute/node";
import { DATA_DIR } from "../config.js";
import type { BackfillScanProgress, ContextRow, GroupMsg } from "../core/messages.js";
import { systemProxy } from "../core/proxy.js";
import { acceptsSender, isIgnoredTelegramBotSender } from "../core/sender-filter.js";
import type { SenderFilter, TelegramMonitorGroup } from "../core/types.js";
import { extractAddresses } from "../wechat/extract.js";
import { isTelegramBotAccount } from "./bot.js";

type Credentials = { apiId: number; apiHash: string };
type Cursor = { id: number; date: number };
type BackfillJob = {
  from: number;
  groups: TelegramMonitorGroup[];
  groupIndex: number;
  cursor: Cursor | null;
  scanned: number;
  accepted: number;
  retryAt: number;
};
export type TelegramLoginState =
  | "needs_credentials" | "signed_out" | "code_sent" | "password_needed" | "connected" | "reconnecting" | "error";
export interface TelegramStatus {
  state: TelegramLoginState;
  configured: boolean;
  account: string | null;
  apiId: number | null;
  codeDelivery: string | null;
  error: string | null;
}
export interface TelegramChatRow {
  peerId: string;
  title: string;
  kind: "group" | "channel";
  lastTimestamp: number;
  watched: boolean;
}
export interface TelegramSenderRow {
  id: string;
  name: string;
  username: string | null;
  messages: number;
}
export interface TelegramBackfillResult {
  groups: number;
  messages: number;
  waiting?: boolean;
  waitSeconds?: number;
  retryAt?: number;
  currentGroup?: string;
  totalGroups?: number;
}

const ROOT = path.join(DATA_DIR, "telegram");
const APP_FILE = path.join(ROOT, "app.json");
const SESSION_FILE = path.join(ROOT, "account.session.sqlite");
const PAGE = 100;
const CACHE_PER_GROUP = 800;
const SEEN_PER_GROUP = 5_000;
const BACKFILL_LIMIT = 50_000;
const PAGE_GAP_MS = 1_000;

const messageKey = (peer: string, id: number) => `tg:${peer}:${id}`;
const errorMessage = (error: unknown) => {
  if (error && typeof error === "object") {
    const value = error as { text?: unknown; message?: unknown };
    if (typeof value.text === "string") return value.text;
    if (typeof value.message === "string") return value.message;
  }
  return String(error);
};
const floodSeconds = (error: unknown): number | null => {
  if (!error || typeof error !== "object") return null;
  const value = error as { seconds?: unknown; text?: unknown; message?: unknown };
  if (typeof value.seconds === "number" && Number.isFinite(value.seconds)) return Math.max(0, value.seconds);
  const match = `${value.text ?? ""} ${value.message ?? ""}`.match(/FLOOD_WAIT_(\d+)/i);
  return match ? Number(match[1]) : null;
};
const loggedOut = (error: unknown) =>
  /AUTH_KEY_(?:UNREGISTERED|INVALID|PERM_EMPTY)|SESSION_REVOKED|USER_DEACTIVATED|SESSION_PASSWORD_NEEDED/i.test(errorMessage(error));

function parseCredentials(raw: unknown): Credentials | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Credentials>;
  if (!Number.isSafeInteger(value.apiId) || (value.apiId ?? 0) <= 0) return null;
  if (typeof value.apiHash !== "string" || !/^[a-f\d]{32}$/i.test(value.apiHash.trim())) return null;
  return { apiId: value.apiId!, apiHash: value.apiHash.trim() };
}

/** Telegram boundary: owns login/session, group updates, bounded context, and explicit history reads. */
export class TelegramMonitor {
  knownMessageRevision: (group: string, sourceId: string) => number | undefined = () => undefined;
  knownDeletePeers: (messageId: number) => string[] = () => [];
  onUnresolvedDelete: (messageId: number) => void = () => {};

  private credentials: Credentials | null = this.loadCredentials();
  private client: TelegramClient | null = null;
  private creating: Promise<TelegramClient> | null = null;
  private state: TelegramLoginState = this.credentials ? "signed_out" : "needs_credentials";
  private account: string | null = null;
  private error: string | null = null;
  private phone: string | null = null;
  private codeHash: string | null = null;
  private codeDelivery: string | null = null;
  private sinceTs = Math.floor(Date.now() / 1000) - 86_400;
  private filters: Record<string, SenderFilter> = {};
  private groups = new Map<string, TelegramMonitorGroup>();
  private context = new Map<string, ContextRow[]>();
  private seenIds = new Map<string, Set<number>>();
  private revisions = new Map<string, number>();
  private historyByPeer = new Map<string, Promise<number>>();
  private historyTail: Promise<void> = Promise.resolve();
  private nextHistoryAt = 0;
  private backfillJob: BackfillJob | null = null;
  onConnected: (() => void) | null = null;
  private transportState = "offline";
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering = false;
  private stopped = false;
  private retryDelay = 30_000;

  constructor(private readonly onMsg: (message: GroupMsg) => void) {}

  status(): TelegramStatus {
    return {
      state: this.state === "connected" && this.transportState !== "connected" ? "reconnecting" : this.state,
      configured: this.credentials !== null,
      account: this.account,
      apiId: this.credentials?.apiId ?? null,
      codeDelivery: this.codeDelivery,
      error: this.error,
    };
  }

  get watchedGroupCount() { return this.state === "connected" ? this.groups.size : 0; }
  get hasBackfillJob() { return this.backfillJob !== null; }
  backfillSinceTs() { return this.sinceTs; }

  private loadCredentials(): Credentials | null {
    try { return parseCredentials(JSON.parse(fs.readFileSync(APP_FILE, "utf8"))); }
    catch { return null; }
  }

  private saveCredentials(value: Credentials) {
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const temporary = `${APP_FILE}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, APP_FILE);
    } finally { try { fs.rmSync(temporary, { force: true }); } catch { /* already renamed */ } }
  }

  private async getClient() {
    if (this.client) return this.client;
    if (!this.creating) this.creating = this.createClient().finally(() => { this.creating = null; });
    return this.creating;
  }

  private async createClient() {
    if (!this.credentials) throw new Error("先填写 Telegram API ID 和 API Hash 并保存");
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const proxy = await systemProxy();
    const client = new TelegramClient({
      apiId: this.credentials.apiId,
      apiHash: this.credentials.apiHash,
      storage: new SqliteStorage(SESSION_FILE),
      ...(proxy ? { transport: new HttpProxyTcpTransport(proxy) } : {}),
      network: { middlewares: networkMiddlewares.basic({
        floodWaiter: { maxWait: 0, maxRetries: 0, minStoredWait: 0, store: true },
      }) },
      updates: { catchUp: true },
    });
    client.onNewMessage.add(message => { void this.receiveWithRetry(message, false).catch(error => this.report(error)); });
    client.onEditMessage.add(message => { void this.receiveWithRetry(message, false, true).catch(error => this.report(error)); });
    client.onDeleteMessage.add(update => this.receiveDeletion(update.channelId, update.messageIds));
    client.onError.add(error => { if (this.state === "connected") this.report(error); });
    this.client = client;
    client.onConnectionState.add(state => this.connectionChanged(client, state));
    return client;
  }

  private connectionChanged(client: TelegramClient, state: string) {
    if (client !== this.client || this.stopped) return;
    this.transportState = state;
    if (state === "connected" && this.state === "connected") {
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.retryDelay = 30_000;
      if (this.state === "connected") this.error = null;
    } else if (this.account || this.state === "error") this.scheduleRecovery();
  }

  private scheduleRecovery() {
    if (this.stopped || this.recoveryTimer || this.recovering || !this.credentials) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.recoverConnection();
    }, this.retryDelay);
    this.recoveryTimer.unref();
  }

  private async recoverConnection() {
    if (this.stopped || this.recovering) return;
    this.recovering = true;
    try {
      // Let mtcute reconnect first. Replace a stuck client after the grace period,
      // retaining its persisted session and resolving the current system proxy.
      await this.closeClient();
      if (this.stopped) return;
      await this.reconnect(this.sinceTs);
    } catch (error) { this.report(error); }
    finally {
      this.recovering = false;
      if (!this.stopped && this.state !== "signed_out" && this.status().state !== "connected") {
        this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
        this.scheduleRecovery();
      }
    }
  }

  private report(error: unknown) {
    this.error = errorMessage(error);
    console.error(`[telegram] ${this.error}`);
  }

  async start(groups: TelegramMonitorGroup[], filters: Record<string, SenderFilter>, sinceTs: number) {
    this.stopped = false;
    this.sync(groups, filters, sinceTs);
    if (!this.credentials) return;
    try { await this.reconnect(sinceTs); }
    catch { /* status carries the actionable error */ }
  }

  async configure(apiId: number, apiHash: string, groups: TelegramMonitorGroup[], filters: Record<string, SenderFilter>, sinceTs: number) {
    const candidate = parseCredentials({ apiId, apiHash: apiHash.trim() || (this.credentials?.apiId === apiId ? this.credentials.apiHash : "") });
    if (!candidate) throw new Error("API ID 须为正整数，API Hash 须为 32 位十六进制字符");
    const changed = candidate.apiId !== this.credentials?.apiId || candidate.apiHash !== this.credentials?.apiHash;
    if (changed) {
      await this.closeClient();
      this.credentials = candidate;
      this.saveCredentials(candidate);
      this.state = "signed_out";
      this.account = null;
      this.error = null;
    }
    this.sync(groups, filters, sinceTs);
    return this.reconnect(sinceTs);
  }

  async reconnect(sinceTs: number) {
    this.sinceTs = sinceTs;
    if (!this.credentials) throw new Error("请先配置 Telegram API ID 和 API Hash");
    try {
      const client = await this.getClient();
      let deadline: ReturnType<typeof setTimeout>;
      const user = await Promise.race([
        client.getMe(),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Telegram 连接超时，正在自动恢复")), 20_000); }),
      ]).finally(() => clearTimeout(deadline));
      if (this.stopped || client !== this.client) return this.status();
      await this.authorize(user, sinceTs);
    } catch (error) {
      if (loggedOut(error)) { this.state = "signed_out"; this.account = null; this.error = null; }
      else { this.state = "error"; this.error = errorMessage(error); this.scheduleRecovery(); }
    }
    return this.status();
  }

  async sendLoginCode(phone: string) {
    const normalized = phone.trim();
    if (!/^\+?[\d\s()-]{7,24}$/.test(normalized)) throw new Error("请输入带国家区号的手机号");
    const client = await this.getClient();
    try {
      const sent = await client.sendCode({ phone: normalized, abortSignal: AbortSignal.timeout(20_000) });
      this.phone = normalized;
      this.error = null;
      if ("phoneCodeHash" in sent) {
        this.codeHash = sent.phoneCodeHash;
        this.codeDelivery = sent.type;
        this.state = "code_sent";
      } else await this.authorize(sent, this.sinceTs);
    } catch (error) {
      const message = errorMessage(error);
      this.error = message;
      throw new Error(message);
    }
    return this.status();
  }

  async verifyLoginCode(code: string) {
    if (!this.client || !this.phone || !this.codeHash) throw new Error("先发送 Telegram 登录验证码");
    try { await this.authorize(await this.client.signIn({ phone: this.phone, phoneCodeHash: this.codeHash, phoneCode: code.trim() }), this.sinceTs); }
    catch (error) {
      if (/SESSION_PASSWORD_NEEDED/i.test(errorMessage(error))) { this.state = "password_needed"; this.error = null; }
      else { this.error = errorMessage(error); throw error; }
    }
    return this.status();
  }

  async verifyPassword(password: string) {
    if (!this.client || this.state !== "password_needed") throw new Error("当前不需要 Telegram 两步验证密码");
    try { await this.authorize(await this.client.checkPassword(password), this.sinceTs); }
    catch (error) { this.error = errorMessage(error); throw error; }
    return this.status();
  }

  private async authorize(user: User, sinceTs: number) {
    this.state = "connected";
    this.account = user.username ? `${user.displayName} (@${user.username})` : user.displayName;
    this.phone = null;
    this.codeHash = null;
    this.codeDelivery = null;
    this.error = null;
    await this.client?.startUpdatesLoop();
    this.sync([...this.groups.values()], this.filters, sinceTs);
    this.onConnected?.();
  }

  sync(groups: TelegramMonitorGroup[], filters: Record<string, SenderFilter>, sinceTs: number) {
    this.sinceTs = sinceTs;
    const next = new Map<string, TelegramMonitorGroup>();
    for (const group of groups) {
      if (!/^-?\d+$/.test(group.peerId)) continue;
      next.set(group.peerId, { peerId: group.peerId, title: group.title.trim().slice(0, 200) || group.peerId, kind: group.kind === "channel" ? "channel" : "group" });
    }
    const old = this.groups;
    const priorFilters = this.filters;
    this.groups = next;
    this.filters = filters;
    for (const id of old.keys()) if (!next.has(id)) this.clearPeer(id);
    if (this.state !== "connected") return;
    for (const [id] of next) {
      const filterChanged = JSON.stringify(priorFilters[`tg:${id}`] ?? null) !== JSON.stringify(filters[`tg:${id}`] ?? null);
      if (!old.has(id) || filterChanged) {
        if (filterChanged) this.clearPeer(id);
        void this.enqueueHistory(id, sinceTs).catch(error => this.report(error));
      }
    }
  }

  private clearPeer(id: string) {
    this.context.delete(id);
    this.seenIds.delete(id);
    for (const key of this.revisions.keys()) if (key.startsWith(`tg:${id}:`)) this.revisions.delete(key);
  }

  private enqueueHistory(peerId: string, sinceTs: number, progress?: (event: Partial<BackfillScanProgress>) => void, cursor: Cursor | null = null) {
    const active = this.historyByPeer.get(peerId);
    if (active) return active;
    const pending = this.historyTail.then(() => this.readHistory(peerId, sinceTs, progress, cursor));
    let tracked: Promise<number>;
    tracked = pending.finally(() => {
      if (this.historyByPeer.get(peerId) === tracked) this.historyByPeer.delete(peerId);
    });
    this.historyByPeer.set(peerId, tracked);
    this.historyTail = tracked.then(() => undefined, () => undefined);
    return tracked;
  }

  private async paceHistory() {
    const wait = this.nextHistoryAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.nextHistoryAt = Date.now() + PAGE_GAP_MS;
  }

  private async readHistory(peerId: string, from: number, progress?: (event: Partial<BackfillScanProgress>) => void, cursor: Cursor | null = null) {
    const client = this.client;
    if (!client || !this.groups.has(peerId)) return 0;
    const page: Message[] = [];
    let nextCursor = cursor;
    let waitSeconds: number | null = null;
    let scanned = 0;
    await this.paceHistory();
    try {
      for await (const message of client.iterHistory(Number(peerId), {
        limit: BACKFILL_LIMIT,
        chunkSize: PAGE,
        ...(cursor ? { offset: cursor } : {}),
      })) {
        const timestamp = Math.floor(message.date.getTime() / 1000);
        if (timestamp < from) break;
        page.push(message);
        scanned += 1;
        nextCursor = { id: message.id, date: timestamp };
        if (scanned % PAGE === 0) {
          progress?.({ phase: "read", scanned, total: null, messages: 0, nextAction: "正在读取群消息" });
          await this.paceHistory();
        }
      }
    } catch (error) {
      waitSeconds = floodSeconds(error);
      if (waitSeconds === null || !progress) throw error;
    }
    const ordered = page.reverse();
    let accepted = 0;
    for (let i = 0; i < ordered.length; i++) {
      if (await this.receive(ordered[i]!, true)) accepted++;
      if (i % 50 === 49 || i === ordered.length - 1) progress?.({ phase: "process", scanned: i + 1, total: ordered.length, messages: accepted, nextAction: "正在整理群消息" });
      if (i % 100 === 99) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (waitSeconds !== null) {
      const error = new Error("Telegram 请求限流") as Error & { waitSeconds: number; cursor: Cursor | null; accepted: number; scanned: number };
      Object.assign(error, { waitSeconds, cursor: nextCursor, accepted, scanned });
      throw error;
    }
    return accepted;
  }

  async backfillSince(sinceTs: number, onProgress?: (progress: BackfillScanProgress) => void, resume = false): Promise<TelegramBackfillResult> {
    if (this.state !== "connected" || !this.client) throw new Error("Telegram 尚未连接，暂时无法回读历史消息");
    if (resume) {
      if (!this.backfillJob) throw new Error("没有可继续的 Telegram 回读任务，请重新开始回读");
      if (Date.now() < this.backfillJob.retryAt) {
        const job = this.backfillJob;
        return { groups: job.groupIndex, messages: job.accepted, waiting: true, waitSeconds: Math.ceil((job.retryAt - Date.now()) / 1000), retryAt: job.retryAt, currentGroup: job.groups[job.groupIndex]?.title, totalGroups: job.groups.length };
      }
    } else {
      if (this.backfillJob) throw new Error("Telegram 回读已暂停，请等待冷却后继续");
      this.backfillJob = { from: sinceTs, groups: [...this.groups.values()], groupIndex: 0, cursor: null, scanned: 0, accepted: 0, retryAt: 0 };
    }
    const job = this.backfillJob!;
    for (let index = job.groupIndex; index < job.groups.length; index++) {
      const group = job.groups[index]!;
      const acceptedBeforeGroup = job.accepted;
      const report = (value: Partial<BackfillScanProgress>) => onProgress?.({
        group: group.title, phase: value.phase ?? "read", scanned: value.scanned ?? 0, total: value.total ?? null,
        messages: acceptedBeforeGroup + (value.messages ?? 0), groupsCompleted: index, groupsTotal: job.groups.length,
        nextAction: value.nextAction, waitSeconds: value.waitSeconds, retryAt: value.retryAt,
      });
      try {
        // Initial live history loading may still be running for this peer.
        // Its rejection must follow the same cleanup/cooldown path as a
        // backfill request; otherwise backfillJob remains permanently locked.
        const active = this.historyByPeer.get(group.peerId);
        if (active) await active;
        const count = await this.enqueueHistory(group.peerId, job.from, report, job.cursor);
        job.accepted += count;
        job.groupIndex = index + 1;
        job.cursor = null;
        report({ phase: "done", scanned: count, total: count, messages: count, nextAction: "当前群已完成" });
      } catch (error) {
        const value = error as Error & { waitSeconds?: number; cursor?: Cursor | null; accepted?: number; scanned?: number };
        const waitSeconds = value.waitSeconds ?? floodSeconds(error) ?? undefined;
        if (!waitSeconds) { this.backfillJob = null; throw error; }
        job.accepted += value.accepted ?? 0;
        job.cursor = value.cursor ?? null;
        job.retryAt = Date.now() + waitSeconds * 1000;
        onProgress?.({ group: group.title, phase: "waiting", scanned: value.scanned ?? 0, total: null, messages: job.accepted, groupsCompleted: index, groupsTotal: job.groups.length, waitSeconds, retryAt: job.retryAt, nextAction: "冷却结束后可从断点继续" });
        return { groups: index, messages: job.accepted, waiting: true, waitSeconds, retryAt: job.retryAt, currentGroup: group.title, totalGroups: job.groups.length };
      }
    }
    const result = { groups: job.groups.length, messages: job.accepted };
    this.backfillJob = null;
    return result;
  }

  async chats(): Promise<TelegramChatRow[]> {
    if (this.state !== "connected" || !this.client) throw new Error("请先登录 Telegram");
    const watched = new Set(this.groups.keys());
    const result: TelegramChatRow[] = [];
    for await (const dialog of this.client.iterDialogs({ limit: 1_000 })) {
      const peer = dialog.peer;
      if (peer.type !== "chat") continue;
      const kind = peer.chatType === "channel" || peer.chatType === "gigagroup" ? "channel" : peer.isGroup ? "group" : null;
      if (!kind) continue;
      result.push({ peerId: String(peer.id), title: peer.title, kind, lastTimestamp: dialog.lastMessage ? Math.floor(dialog.lastMessage.date.getTime() / 1000) : 0, watched: watched.has(String(peer.id)) });
    }
    return result;
  }

  async senders(peerId: string): Promise<TelegramSenderRow[]> {
    if (this.state !== "connected" || !this.client) throw new Error("请先登录 Telegram");
    if (!/^-?\d+$/.test(peerId)) throw new Error("Telegram 群组编号无效");
    const [chat] = await this.client.getChats([Number(peerId)]);
    if (!chat || chat.type !== "chat" || !chat.isGroup) throw new Error("找不到可访问的 Telegram 群组");
    const result = new Map<string, TelegramSenderRow>();
    let scanned = 0;
    for await (const message of this.client.iterHistory(Number(peerId), { limit: 600 })) {
      if (++scanned > 600) break;
      if (message.sender.type !== "user") continue;
      const sender = message.sender;
      if (isIgnoredTelegramBotSender(sender.username, `tg:${peerId}`)) continue;
      const id = String(sender.id);
      const item = result.get(id);
      if (item) item.messages++;
      else result.set(id, { id, name: sender.displayName, username: sender.username, messages: 1 });
    }
    return [...result.values()].sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name, "zh-Hans-CN"));
  }

  readAround(group: string, timestamp: number, before: number, after: number, sourceMessageId?: string): ContextRow[] {
    const peerId = group.startsWith("tg:") ? group.slice(3) : "";
    const rows = this.context.get(peerId) ?? [];
    if (!rows.length) return [];
    let at = sourceMessageId ? rows.findIndex(row => row.sourceId === sourceMessageId) : -1;
    if (at < 0) { at = rows.findIndex(row => row.createTime >= timestamp); if (at < 0) at = rows.length - 1; }
    return rows.slice(Math.max(0, at - before), Math.min(rows.length, at + after + 1));
  }

  private async receiveWithRetry(message: Message, backfill: boolean, edited = false): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.receive(message, backfill, edited); }
      catch (error) {
        if (attempt >= 2 || !this.client) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }

  private async receive(message: Message, backfill: boolean, edited = false): Promise<boolean> {
    const detectedAtMs = Date.now();
    if (message.chat.type !== "chat") return false;
    const isChannel = message.chat.chatType === "channel" || message.chat.chatType === "gigagroup";
    if (!message.chat.isGroup && !isChannel) return false;
    const peerId = String(message.chat.id);
    if (!this.groups.has(peerId)) return false;
    const key = messageKey(peerId, message.id);
    edited = edited || !!message.editDate;
    const revision = message.editDate?.getTime() ?? 0;
    const previous = this.revisions.get(key) ?? this.knownMessageRevision(`tg:${peerId}`, key);
    if (previous !== undefined && revision < previous) return false;
    const seen = this.seenIds.get(peerId) ?? new Set<number>();
    if (!edited && seen.has(message.id)) return false;

    const sender = message.sender;
    const senderId = sender.type === "user" ? String(sender.id) : undefined;
    const senderName = sender.displayName || (sender.type === "user" && sender.username ? `@${sender.username}` : "未知");
    const senderAliases = sender.type === "user" ? [...new Set([sender.displayName.trim(), sender.username ? `@${sender.username}` : ""].filter(Boolean))] : undefined;
    const text = message.text.trim();
    const parsed = extractAddresses(text, 1);
    const time = Math.floor(message.date.getTime() / 1000);
    const row: ContextRow = { createTime: time, sourceId: key, sender: senderName, text: text.slice(0, 500), addrs: parsed.addrs, chainHint: parsed.chainHint };
    const rows = this.context.get(peerId) ?? [];
    const at = rows.findIndex(item => item.sourceId === key);
    if (at >= 0) rows[at] = row;
    else rows.push(row);
    rows.sort((a, b) => a.createTime - b.createTime || a.sourceId.localeCompare(b.sourceId));
    if (rows.length > CACHE_PER_GROUP) rows.splice(0, rows.length - CACHE_PER_GROUP);
    this.context.set(peerId, rows);
    if (!isChannel && sender.type === "user" && isIgnoredTelegramBotSender(sender.username, `tg:${peerId}`)) return false;
    // Existing calls must remain correct after a sender selection changes.
    // Only an accepted/persisted message may bypass the current filter on edit.
    const knownEdit = edited && (previous != null || seen.has(message.id));
    if ((!isChannel && !knownEdit && !acceptsSender(this.filters[`tg:${peerId}`], senderId)) || (!parsed.addrs.length && !edited)) return false;
    const isBot = sender.type === "user" && isTelegramBotAccount(sender);
    this.onMsg({
      t: "msg", group: `tg:${peerId}`, sourceId: key, messageEvent: edited ? "edit" : undefined,
      messageRevision: message.editDate?.getTime(), time, detectedAtMs, sender: senderName, senderId, senderAliases,
      senderUsername: sender.type === "user" ? sender.username ?? "" : undefined,
      isBot, text: text.slice(0, 300), addrs: parsed.addrs, chainHint: parsed.chainHint, backfill,
    });
    this.revisions.set(key, revision);
    if (this.revisions.size > 5_000) this.revisions.delete(this.revisions.keys().next().value!);
    seen.add(message.id);
    if (seen.size > SEEN_PER_GROUP) seen.delete(seen.values().next().value!);
    this.seenIds.set(peerId, seen);
    return true;
  }

  private receiveDeletion(channelId: number | null, ids: number[]) {
    for (const id of ids) {
      const possible = channelId !== null
        ? [String(channelId)]
        : [...this.knownDeletePeers(id), ...[...this.context].filter(([peer,rows])=>rows.some(row=>row.sourceId===messageKey(peer,id))).map(([peer])=>peer)];
      const peers = [...new Set(possible)].filter(peer => this.groups.has(peer));
      if (peers.length !== 1) { this.onUnresolvedDelete(id); continue; }
      const peer = peers[0]!;
      const key = messageKey(peer, id);
      const cached=this.context.get(peer)?.find(row=>row.sourceId===key);
      let revision=Math.max(Date.now(),Number(this.revisions.get(key)||0)+1,Number(cached?.createTime||0)*1000+1);
      try{revision=Math.max(revision,Number(this.knownMessageRevision(`tg:${peer}`,key)||0)+1);}catch{}
      this.onMsg({ t: "msg", group: `tg:${peer}`, sourceId: key, messageEvent: "delete", messageRevision: revision, time: Math.floor(Date.now() / 1000), sender: "?", text: "", addrs: [], chainHint: null, backfill: false });
      this.revisions.set(key,revision);
      this.context.set(peer, (this.context.get(peer) ?? []).filter(row => row.sourceId !== key));
    }
  }

  private async closeClient() {
    const client = this.client;
    this.client = null;
    this.transportState = "offline";
    if (client) await client.destroy();
  }

  async stop() {
    this.stopped = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    try { await this.closeClient(); }
    catch (error) { this.report(error); }
  }
}
