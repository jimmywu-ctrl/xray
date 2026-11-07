import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { requestJson } from "../core/proxy.js";

export interface CapturedCa {
  address: string;
  chain: string | null;
  symbol: string | null;
  mc?: number | null;
  sender: string;
  group: string;
  groupName: string;
  time: number;
  sourceId?: string;
  telegramSenderId: string | null;
  senderId?: string | null;
}

export interface TelegramForwardSender {
  id: string;
  name: string;
  username: string | null;
}

export interface TelegramForwardGroupFilter {
  groupId: string;
  groupName: string;
  senders: TelegramForwardSender[];
}

interface BotConfig {
  token: string;
  target: string;
  enabled: boolean;
  filters: TelegramForwardGroupFilter[];
}

interface PendingPush {
  key: string;
  call: CapturedCa;
  target: string;
  messageId?: number;
  timer?: NodeJS.Timeout;
  editTask?: Promise<void>;
  dirty: boolean;
}

interface SendingOperation {
  group: string;
  sourceId?: string;
  cancelled: boolean;
}

export interface TelegramBotStatus {
  configured: boolean;
  enabled: boolean;
  target: string;
  filters: TelegramForwardGroupFilter[];
  lastError: string | null;
}

export interface TelegramBotConnectionCheck {
  status: TelegramBotStatus;
  targetType: "group" | "supergroup" | "channel";
  targetName: string;
}

const CONFIG_PATH = path.join(DATA_DIR, "telegram-bot-api.json");
const EMPTY_CONFIG: BotConfig = { token: "", target: "", enabled: false, filters: [] };
const SYMBOL_WAIT_MS = 60_000;
const MAX_PENDING = 500;
const CHAIN_LABELS: Record<string, string> = {
  robinhood: "RH", bsc: "BSC", base: "BASE", sol: "SOL", eth: "ETH",
  arbitrum: "ARB", hyperevm: "HYPE", arc: "ARC", stable: "STABLE", monad: "MONAD",
};

function messageKey(call: Pick<CapturedCa, "address" | "group" | "sender" | "time" | "sourceId">): string {
  return JSON.stringify([call.address, normalizedGroup(call.group), call.sender, call.time, call.sourceId ?? null]);
}

function normalizedGroup(group: string): string {
  return group.replace(/^tg:/, "");
}

function targetValue(value: string): string {
  const target = value.trim();
  const link = target.match(/^https?:\/\/(?:www\.)?t\.me\/([A-Za-z0-9_]{5,32})\/?$/i);
  if (link) return `@${link[1]}`;
  if (/^-?\d+$/.test(target) || /^@[A-Za-z0-9_]{5,32}$/.test(target)) return target;
  throw new Error("目标请填写群/频道的数字 chat_id，或公开群/频道的 @username");
}

function normalizeFilters(input: unknown, strict: boolean): TelegramForwardGroupFilter[] {
  const invalid = (): never | TelegramForwardGroupFilter[] => {
    if (strict) throw new Error("Telegram 转发筛选格式无效");
    return [];
  };
  if (input === undefined && !strict) return [];
  if (!Array.isArray(input) || input.length > 100) return invalid();

  const byGroup = new Map<string, TelegramForwardGroupFilter>();
  for (const value of input) {
    const group = asRecord(value);
    if (!group || typeof group.groupId !== "string" || !validGroupId(group.groupId) ||
        typeof group.groupName !== "string" || !Array.isArray(group.senders) || group.senders.length > 200) return invalid();

    const senders = new Map<string, TelegramForwardSender>();
    for (const value of group.senders) {
      const sender = asRecord(value);
      if (!sender || typeof sender.id !== "string" || !validSenderId(group.groupId, sender.id) ||
          typeof sender.name !== "string" || !(sender.username === null || typeof sender.username === "string")) return invalid();
      senders.set(sender.id, {
        id: sender.id,
        name: cleanText(sender.name, 160) || sender.id,
        username: typeof sender.username === "string" ? cleanText(sender.username.replace(/^@/, ""), 64) || null : null,
      });
    }
    if (senders.size === 0) continue;
    const previous = byGroup.get(group.groupId);
    for (const sender of previous?.senders ?? []) if (!senders.has(sender.id)) senders.set(sender.id, sender);
    byGroup.set(group.groupId, {
      groupId: group.groupId,
      groupName: cleanText(group.groupName, 160) || group.groupId,
      senders: [...senders.values()],
    });
  }
  return [...byGroup.values()];
}

function validGroupId(id: string): boolean {
  return /^-?\d+$/.test(id) || /^[A-Za-z0-9_-]+@chatroom$/.test(id);
}

function validSenderId(groupId: string, senderId: string): boolean {
  return groupId.endsWith("@chatroom")
    ? /^[^\s\x00-\x1f]{1,200}$/.test(senderId)
    : /^\d+$/.test(senderId);
}

export function isAllowedByTelegramForwardFilter(
  call: Pick<CapturedCa, "group" | "telegramSenderId" | "senderId">,
  filters: readonly TelegramForwardGroupFilter[],
): boolean {
  const telegram = call.group.startsWith("tg:");
  const groupId = normalizedGroup(call.group);
  const senderId = telegram ? call.telegramSenderId : call.senderId;
  const group = filters.find((entry) => entry.groupId === groupId);
  return !!senderId && !!group?.senders.some((sender) => sender.id === senderId);
}

function loadConfig(): BotConfig {
  try {
    const raw = asRecord(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
    if (!raw) return { ...EMPTY_CONFIG };
    return {
      token: typeof raw.token === "string" ? raw.token : "",
      target: typeof raw.target === "string" ? raw.target : "",
      enabled: raw.enabled === true,
      filters: normalizeFilters(raw.filters, false),
    };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

/** Bot API credentials stay in the local data directory and are never returned to the UI. */
export class TelegramBotPublisher {
  private config = loadConfig();
  private lastError: string | null = null;
  private botId: string | null = null;
  private botLookup: Promise<string> | null = null;
  private checkedTarget: { token: string; target: string; type: "group" | "supergroup" | "channel"; name: string } | null = null;
  private targetLookup: Promise<{ type: "group" | "supergroup" | "channel"; name: string }> | null = null;
  private readonly pending = new Map<string, PendingPush>();
  private readonly sending = new Set<SendingOperation>();

  status(): TelegramBotStatus {
    return {
      configured: this.config.token.length > 0,
      enabled: this.config.enabled,
      target: this.config.target,
      filters: this.config.filters.map((row) => ({ ...row, senders: row.senders.map((sender) => ({ ...sender })) })),
      lastError: this.lastError,
    };
  }

  isOwnTelegramSender(senderId: string): boolean {
    return this.botId !== null && senderId === this.botId;
  }

  configure(input: { token?: string; target?: string; enabled?: boolean; clearToken?: boolean; filters?: unknown }): TelegramBotStatus {
    const supplied = input.token?.trim() ?? "";
    if (supplied && !/^\d+:[A-Za-z0-9_-]+$/.test(supplied)) throw new Error("Bot API Token 格式无效，请从 BotFather 复制完整 Token");
    const next: BotConfig = {
      token: input.clearToken ? "" : supplied || this.config.token,
      target: input.target === undefined ? this.config.target : input.target.trim() ? targetValue(input.target) : "",
      enabled: input.enabled ?? this.config.enabled,
      filters: input.filters === undefined ? this.config.filters : normalizeFilters(input.filters, true),
    };
    if (next.enabled && !next.token) throw new Error("启用推送前请先填写 Telegram Bot API Token");
    if (next.enabled && !next.target) throw new Error("启用推送前请先填写群或频道目标");

    this.discardAllPending();
    this.config = next;
    this.botId = null;
    this.botLookup = null;
    this.checkedTarget = null;
    this.targetLookup = null;
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, CONFIG_PATH);
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* rename already removed it */ }
    }
    this.lastError = null;
    return this.status();
  }

  async checkConnection(): Promise<TelegramBotConnectionCheck> {
    try {
      await this.getBotId();
      const target = await this.getTarget();
      this.lastError = null;
      return { status: this.status(), targetType: target.type, targetName: target.name };
    } catch (error) {
      this.rememberError(error);
      throw error;
    }
  }

  async sendTest(): Promise<TelegramBotStatus> {
    try {
      await this.getBotId();
      await this.getTarget();
      await this.sendMessage("✅ X-ray Bot API 测试消息：此群/频道已连接。");
      this.lastError = null;
      return this.status();
    } catch (error) {
      this.rememberError(error);
      throw error;
    }
  }

  canPublish(call: CapturedCa): boolean {
    return this.config.enabled && normalizedGroup(call.group)!==normalizedGroup(this.config.target) && isAllowedByTelegramForwardFilter(call,this.config.filters);
  }
  async publish(call: CapturedCa): Promise<boolean> {
    const config = this.config;
    if (!this.canPublish(call)) return false;
    const operation: SendingOperation = { group: call.group, sourceId: call.sourceId, cancelled: false };
    this.sending.add(operation);
    const key = messageKey(call);
    const pending: PendingPush | null = call.symbol?.trim()
      ? null
      : { key, call: { ...call }, target: config.target, dirty: false };
    if (pending) this.keepPending(pending);

    try {
      const botId = await this.getBotId();
      if (call.telegramSenderId === botId) {
        if (pending) this.finishPending(pending);
        return false;
      }
      await this.getTarget();
      if (!this.isCurrent(config, operation)) {
        if (pending) this.finishPending(pending);
        return false;
      }

      const messageId = await this.sendMessage(formatCapturedCaMessage(call), config.target, call.address);
      if (!this.isCurrent(config, operation)) {
        if (messageId !== null) await this.deleteMessage(config.target, messageId);
        if (pending) this.finishPending(pending);
        return false;
      }

      if(messageId===null)throw Error("Telegram 未返回消息 ID，待重试确认");
      if (pending) {
        if (messageId === null) this.finishPending(pending);
        else {
          pending.messageId = messageId;
          if (pending.call.symbol) await this.editPending(pending);
          else {
            const left = Math.max(0, pending.call.time * 1000 + SYMBOL_WAIT_MS - Date.now());
            pending.timer = setTimeout(() => this.finishPending(pending), left);
          }
        }
      }
      this.lastError = null;
      return true;
    } catch (error) {
      if (pending) this.finishPending(pending);
      this.rememberError(error);
      console.error(`[telegram-bot] publish failed: ${this.lastError}`);
      throw error;
    } finally {
      this.sending.delete(operation);
    }
  }

  cancelMessage(group: string, sourceId: string): void {
    const targetGroup = normalizedGroup(group);
    for (const operation of this.sending) {
      if (normalizedGroup(operation.group) === targetGroup && operation.sourceId === sourceId) operation.cancelled = true;
    }
    for (const pending of this.pending.values()) {
      if (normalizedGroup(pending.call.group) === targetGroup && pending.call.sourceId === sourceId) this.finishPending(pending);
    }
  }

  async updateTokenSymbol(call: CapturedCa): Promise<void> {
    const symbol = call.symbol?.trim();
    if (!symbol) return;
    const pending = this.pending.get(messageKey(call));
    if (!pending) return;
    pending.call = {
      ...pending.call,
      symbol: cleanText(symbol, 32),
      chain: call.chain ?? pending.call.chain,
      mc: call.mc ?? pending.call.mc ?? null,
    };
    if (pending.messageId !== undefined) await this.editPending(pending);
  }

  private keepPending(entry: PendingPush): void {
    this.pending.set(entry.key, entry);
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.values().next().value as PendingPush | undefined;
      if (!oldest) break;
      this.finishPending(oldest);
    }
  }

  private isCurrent(config: BotConfig, operation: SendingOperation): boolean {
    return config === this.config && !operation.cancelled && this.config.enabled;
  }

  private async editPending(entry: PendingPush): Promise<void> {
    if (entry.messageId === undefined || this.pending.get(entry.key) !== entry) return;
    if (entry.editTask) {
      entry.dirty = true;
      await entry.editTask;
      return;
    }
    entry.editTask = (async () => {
      do {
        entry.dirty = false;
        if (this.pending.get(entry.key) !== entry || !this.config.enabled ||
            !isAllowedByTelegramForwardFilter(entry.call, this.config.filters)) {
          this.finishPending(entry);
          return;
        }
        try {
          await this.callApi("editMessageText", {
            chat_id: entry.target,
            message_id: entry.messageId,
            text: formatCapturedCaMessage(entry.call),
            parse_mode: "HTML",
            reply_markup: copyButton(entry.call.address),
          });
          this.lastError = null;
          if (!entry.dirty) this.finishPending(entry);
        } catch (error) {
          this.rememberError(error);
          console.error(`[telegram-bot] symbol update failed: ${this.lastError}`);
          return;
        }
      } while (entry.dirty);
    })().finally(() => { entry.editTask = undefined; });
    await entry.editTask;
  }

  private finishPending(entry: PendingPush): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key);
  }

  private discardAllPending(): void {
    for (const entry of this.pending.values()) this.finishPending(entry);
  }

  private async getBotId(): Promise<string> {
    if (this.botId) return this.botId;
    if (!this.botLookup) {
      const token = this.config.token;
      const lookup = this.callApi("getMe", {}).then((body) => {
        const result = asRecord(body.result);
        if (typeof result?.id !== "number" && typeof result?.id !== "string") throw new Error("Telegram Bot API getMe 未返回机器人 ID");
        if (token !== this.config.token) throw new Error("Bot API 设置已变更，请重试");
        const id = String(result.id);
        this.botId = id;
        return id;
      }).finally(() => { if (this.botLookup === lookup) this.botLookup = null; });
      this.botLookup = lookup;
    }
    return this.botLookup;
  }

  private async getTarget(): Promise<{ type: "group" | "supergroup" | "channel"; name: string }> {
    if (!this.config.target) throw new Error("尚未设置 Telegram 群或频道目标");
    const token = this.config.token;
    const target = this.config.target;
    if (this.checkedTarget?.token === token && this.checkedTarget.target === target) {
      return { type: this.checkedTarget.type, name: this.checkedTarget.name };
    }
    if (!this.targetLookup) {
      const lookup = this.callApi("getChat", { chat_id: target }).then((body) => {
        const chat = asRecord(body.result);
        const type = chat?.type;
        if (!chat || (type !== "group" && type !== "supergroup" && type !== "channel")) {
          throw new Error(`目标不是群或频道（Telegram 返回类型：${typeof type === "string" ? type : "未知"}）`);
        }
        if (token !== this.config.token || target !== this.config.target) throw new Error("Bot API 设置已变更，请重新检查连接");
        const name = typeof chat.title === "string" ? chat.title : typeof chat.username === "string" ? `@${chat.username}` : target;
        this.checkedTarget = { token, target, type, name };
        return { type, name };
      }).finally(() => { if (this.targetLookup === lookup) this.targetLookup = null; });
      this.targetLookup = lookup;
    }
    return this.targetLookup;
  }

  private async sendMessage(text: string, target = this.config.target, address?: string): Promise<number | null> {
    const body = await this.callApi("sendMessage", {
      chat_id: target,
      text,
      parse_mode: "HTML",
      ...(address ? { reply_markup: copyButton(address) } : {}),
    });
    const result = asRecord(body.result);
    return Number.isSafeInteger(result?.message_id) ? result!.message_id as number : null;
  }

  private async deleteMessage(target: string, messageId: number): Promise<void> {
    try { await this.callApi("deleteMessage", { chat_id: target, message_id: messageId }); }
    catch (error) { console.error(`[telegram-bot] cancelled message cleanup failed: ${errorMessage(error)}`); }
  }

  private async callApi(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = this.config.token;
    if (!token) throw new Error("尚未设置 Bot API Token");
    const response = await requestJson(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body: payload,
      timeoutMs: 15_000,
    });
    const body = asRecord(response.json);
    if (!body) throw new Error(`Telegram Bot API 返回无法解析的响应（HTTP ${response.status}）`);
    if (response.status < 200 || response.status >= 300 || body.ok !== true) {
      const description = typeof body.description === "string" ? body.description : "请求失败";
      const parameters = asRecord(body.parameters);
      const retry = typeof parameters?.retry_after === "number" ? parameters.retry_after : null;
      throw new Error(`Telegram Bot API ${response.status}: ${description}${retry ? `；请 ${retry} 秒后重试` : ""}`);
    }
    return body;
  }

  private rememberError(error: unknown): void {
    this.lastError = errorMessage(error);
  }
}

function formatCapturedCaMessage(call: CapturedCa): string {
  const symbol = cleanText(call.symbol ?? "", 32) || "待识别";
  const chainKey = cleanText(call.chain ?? "", 32).toLowerCase();
  const chain = CHAIN_LABELS[chainKey] ?? (chainKey ? chainKey.toUpperCase() : "未知");
  const sender = cleanText(call.sender, 100) || "未知";
  const timestamp = Number.isFinite(call.time) ? call.time * 1000 : Date.now();
  const shoutTime = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(timestamp));
  return [
    `名称：${escapeHtml(symbol)}`,
    `合约: <code>${escapeHtml(cleanText(call.address, 128))}</code>`,
    `所属链：${escapeHtml(chain)}`,
    `MC：${formatMarketCap(call.mc)}`,
    `喊单人：${escapeHtml(sender)}`,
    `喊单时间：${escapeHtml(shoutTime)}`,
  ].join("\n");
}

function copyButton(address: string) {
  return { inline_keyboard: [[{ text: "📋 复制完整 CA", copy_text: { text: address } }]] };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]!));
}

function cleanText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, maxLength);
}

function formatMarketCap(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1e15) return "";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
