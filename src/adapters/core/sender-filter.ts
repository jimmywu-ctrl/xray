import type { SenderFilter } from "./types.js";

const NAMED_BOT_SENDERS = new Set(["人工智能机器人", "人工智能和机器人", "phanes"]);
const TELEGRAM_BOT_HANDLES = new Set(["rick"]);

function normalizedIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const result = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (id) result.add(id);
    if (result.size >= 500) break;
  }
  return [...result];
}

export function cleanSenderFilter(value: unknown): SenderFilter {
  const candidate = value && typeof value === "object"
    ? value as Partial<SenderFilter>
    : undefined;
  return {
    includeSenderIds: normalizedIds(candidate?.includeSenderIds),
    blockedSenderIds: normalizedIds(candidate?.blockedSenderIds),
  };
}

/** A non-empty allow-list is restrictive; an explicit block always takes precedence. */
export function acceptsSender(
  filter: SenderFilter | undefined,
  senderId: string | null | undefined,
): boolean {
  if (!filter) return true;
  const id = typeof senderId === "string" ? senderId.trim() : "";
  const allow = filter.includeSenderIds;
  const block = filter.blockedSenderIds;

  if (!id) return allow.length === 0 && block.length === 0;
  if (block.includes(id)) return false;
  return allow.length === 0 || allow.includes(id);
}

/** Stable Telegram bot identity is preferred; names are a compatibility fallback for older WeChat cards. */
export function isBotSender(
  name: string | null | undefined,
  group?: string | null,
  knownBot?: boolean,
  username?: string | null,
): boolean {
  const isTelegram = group?.startsWith("tg:") === true;
  if (isTelegram && knownBot !== undefined) return knownBot;
  const identity = (username ?? name)?.trim();
  if (!identity) return false;
  if (NAMED_BOT_SENDERS.has(identity.toLowerCase()) || /人工智能\s*和?\s*机器人/.test(identity)) return true;
  const handle = identity.replace(/^@/, "").toLowerCase();
  if ((identity.startsWith("@") || isTelegram) && TELEGRAM_BOT_HANDLES.has(handle)) return true;
  return isTelegram && /^@[a-z0-9_]+bot$/i.test(identity);
}

/** Ignore the known Telegram analytics card account even when it is not a chat-level bot. */
export function isIgnoredTelegramBotSender(
  username: string | null | undefined,
  group?: string | null,
): boolean {
  if (!group?.startsWith("tg:") || !username) return false;
  const normalized = username.trim().replace(/^@/, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "safeanalyzerbot";
}
