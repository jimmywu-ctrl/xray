import { isSolanaPublicKey } from "../core/solana-mint.js";

export interface Extracted {
  addrs: string[];
  chainHint: string | null;
}

type AddressKind = "evm" | "sol";
type Candidate = { address: string; kind: AddressKind };

const EVM_ADDRESS = /(?<![a-z\d])0x[a-f\d]{40}(?![a-f\d])/gi;
const BASE58_CHARACTER = "[1-9A-HJ-NP-Za-km-z]";
const SOLANA_CANDIDATE = new RegExp(`(?<!${BASE58_CHARACTER})${BASE58_CHARACTER}{32,44}(?!${BASE58_CHARACTER})`, "g");
const TRACKING_OR_WALLET_HOSTS = new Set([
  "arkm.com",
  "arkhamintelligence.com",
  "farcaster.xyz",
  "warpcast.com",
]);

const CHAIN_ALIASES = new Map<string, string>([
  ["sol", "sol"], ["solana", "sol"],
  ["eth", "eth"], ["ethereum", "eth"],
  ["bsc", "bsc"], ["bnb", "bsc"], ["binance", "bsc"],
  ["base", "base"], ["arb", "arbitrum"], ["arbitrum", "arbitrum"],
  ["op", "optimism"], ["optimism", "optimism"], ["polygon", "polygon"],
  ["avax", "avalanche"], ["avalanche", "avalanche"],
  ["xlayer", "xlayer"], ["x-layer", "xlayer"],
  ["rh", "robinhood"], ["robinhood", "robinhood"],
  ["hyper", "hyperevm"], ["hyperevm", "hyperevm"],
  ["arc", "arc"], ["stable", "stable"], ["mon", "monad"],
  ["monad", "monad"], ["megaeth", "megaeth"], ["giwa", "giwa"],
]);

const ADDRESS_CONTEXT_EXCLUSIONS = /(?:这(?:个|种)?地址.{0,24}(?:怎么|咋|如何).{0,8}(?:买|买到|买币)|(?:为什么|为啥|怎么).{0,24}(?:不显示|没有显示|看不到).{0,8}(?:转入|买入|买币)|(?:是不是|是否|这是).{0,18}(?:官方|项目方|他|她|我|你的|对方).{0,12}地址|(?:钱包|持有人|官方|项目方).{0,12}地址.{0,16}(?:查询|验证|确认|是谁)|(?:验证|确认|查询|追踪).{0,12}(?:这个|这|该)?地址|(?:赔偿|空投|退款|捐赠|桥接|客服|收款|欺诈|钓鱼).{0,24}(?:地址|合约)|(?:地址|合约).{0,24}(?:赔偿|空投|退款|捐赠|桥接|客服|收款|核验))/i;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([\da-f]+);/gi, (entity, digits: string) => decodeCodePoint(entity, Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (entity, digits: string) => decodeCodePoint(entity, Number.parseInt(digits, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodeCodePoint(original: string, point: number): string {
  if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) return original;
  try { return String.fromCodePoint(point); } catch { return original; }
}

function isQuoteReply(xml: string): boolean {
  return /<appmsg\b[\s\S]*?<type>\s*57\s*<\/type>/i.test(xml);
}

function getLinkPayload(xml: string): string {
  if (isQuoteReply(xml)) {
    // A reply's own title is the only message authored by the sender. Do not scan refermsg.
    const title = xml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    return decodeXmlText(title);
  }

  const appMessage = xml.match(/<appmsg(?:\s[^>]*)?>([\s\S]*?)<\/appmsg>/i)?.[1] ?? xml;
  const visible = appMessage.replace(/<(refermsg|emojiinfo)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const fields: string[] = [];
  for (const match of visible.matchAll(/<(url|title|des)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    fields.push(decodeXmlText(match[2] ?? ""));
  }
  return fields.join("\n");
}

function isPriceBotCard(text: string): boolean {
  if (/战力[：:]/.test(text) && /血量[：:]/.test(text)) return true;
  if (/\bMC[A-Z0-9_-]*\s*\(\s*[^)]+\s*\)/i.test(text) && /(?:实时|当前)[：:]/.test(text) && /(?:高度|市值|血量)[：:]/.test(text)) return true;
  if (/金蛙农场|全力忽悠版|HODLO_AI/i.test(text)) return true;
  if (/人工智能和机器人/.test(text) && /金蛙|忽悠|本群\s*[:：]\s*\d+次/.test(text)) return true;
  return /数据来源\s*[:：]\s*AVE/i.test(text) && /本群\s*[:：]\s*\d+次/.test(text);
}

/** Remove links whose explicit path is about a wallet, transaction or social post. */
export function tokenCandidateText(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/gi, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.toLowerCase();
      const path = url.pathname;
      const blockedHost = [...TRACKING_OR_WALLET_HOSTS].some((domain) => host === domain || host.endsWith(`.${domain}`));
      const blockedPath = /\/(?:tx|transaction|wallet|cast|casts|profile|builder|account|user)(?:\/|$)/i.test(path) ||
        /(?:^|[?&])castHash=/i.test(url.search);
      return blockedHost || blockedPath ? " " : rawUrl;
    } catch {
      return rawUrl;
    }
  }).replace(/0x[a-f\d]{41,}/gi, " ").replace(/\bcastHash\s*[:=]\s*["']?0x[a-f\d]+/gi, " ");
}

/** Explicit wallet/address discussion should not become a token call. */
export function isExplicitNonTokenAddress(text: string, address: string): boolean {
  if (!address || !text.toLowerCase().includes(address.toLowerCase())) return false;
  const candidateText = tokenCandidateText(text).toLowerCase();
  return !candidateText.includes(address.toLowerCase()) || ADDRESS_CONTEXT_EXCLUSIONS.test(text);
}

function findCandidates(text: string): Candidate[] {
  const byKey = new Map<string, Candidate>();
  const add = (address: string, kind: AddressKind) => {
    const canonical = kind === "evm" ? address.toLowerCase() : address;
    byKey.set(`${kind}:${canonical}`, { address: canonical, kind });
  };

  for (const match of text.matchAll(EVM_ADDRESS)) add(match[0], "evm");
  for (const match of text.matchAll(SOLANA_CANDIDATE)) {
    if (isSolanaPublicKey(match[0])) add(match[0], "sol");
  }
  return [...byKey.values()];
}

function chainFromUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const pathParts = url.pathname.split("/").filter(Boolean);
  let rawChain: string | undefined;

  if (["dexscreener.com", "debot.ai", "ave.ai"].some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    rawChain = pathParts.find((part) => CHAIN_ALIASES.has(part.toLowerCase()));
  } else if (host === "etherscan.io" || host.endsWith(".etherscan.io")) rawChain = "eth";
  else if (host === "bscscan.com" || host.endsWith(".bscscan.com") || host === "four.meme") rawChain = "bsc";
  else if (host === "basescan.org" || host.endsWith(".basescan.org")) rawChain = "base";
  else if (host === "solscan.io" || host.endsWith(".solscan.io")) rawChain = "sol";
  else if (host === "arbiscan.io" || host.endsWith(".arbiscan.io")) rawChain = "arbitrum";
  else if (host === "polygonscan.com" || host.endsWith(".polygonscan.com")) rawChain = "polygon";

  return rawChain ? CHAIN_ALIASES.get(rawChain.toLowerCase()) ?? null : null;
}

function chainFromText(text: string): string | null {
  const hints = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const chain = chainFromUrl(match[0].replace(/[),.;]+$/, ""));
    if (chain) hints.add(chain);
  }
  return hints.size === 1 ? [...hints][0] : null;
}

function explicitChain(text: string): string | null {
  const hostHint = chainFromText(text);
  if (hostHint) return hostHint;
  if (/(?:\bsolana\b|\bsol\s*(?:链|chain)\b)/i.test(text)) return "sol";
  if (/(?:\bbsc\b|\bbnb\s*(?:链|chain)\b|\bon\s+bnb\b)/i.test(text)) return "bsc";
  if (/(?:\beth(?:ereum)?\s*(?:链|chain)\b)/i.test(text)) return "eth";
  if (/\bbase\s*(?:链|chain)\b/i.test(text)) return "base";
  return null;
}

/** Extract only token-shaped candidates from user-authored text or link-card content. */
export function extractAddresses(input: string, messageType: number): Extracted {
  if (messageType !== 1 && messageType !== 49) return { addrs: [], chainHint: null };
  const text = messageType === 49 ? getLinkPayload(input) : input;
  if (isPriceBotCard(text)) return { addrs: [], chainHint: null };

  const searchable = tokenCandidateText(text);
  const candidates = findCandidates(searchable).filter((candidate) =>
    !isExplicitNonTokenAddress(text, candidate.address),
  );
  const addresses = candidates.map(({ address }) => address);
  let chainHint = explicitChain(text);

  if (!chainHint) {
    const kinds = new Set(candidates.map(({ kind }) => kind));
    if (kinds.size === 1 && kinds.has("sol")) chainHint = "sol";
  }
  return { addrs: addresses, chainHint };
}

/** Keep card text readable while ensuring scanner URLs cannot masquerade as authored calls. */
export function displayText(text: string, messageType: number): string {
  if (messageType !== 49) return text;
  const payload = getLinkPayload(text).trim();
  if (isPriceBotCard(payload)) {
    const visibleLines = payload.split("\n").filter((line) => !/^https?:\/\/\S+$/i.test(line.trim()));
    return visibleLines.join("\n").trim() || payload;
  }
  const title = decodeXmlText(text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  return title ? `[链接] ${title}` : "[链接]";
}

export function isBotCard(text: string): boolean {
  return isPriceBotCard(text);
}
