import type { AveQueryResult, Market } from "./types.js";
import type { Bridge } from "./rpc.js";
import { normalizeTokenAddress, tokenChainKey } from "./identity.js";
import { ApiAccessBlockedError, ApiRateLimitError, RequestScheduler, type RequestPriority } from "./request-scheduler.js";
import { MAX_PLAUSIBLE_MARKET_CAP_USD, plausibleMarketCap } from "./quote-contract.js";
import { isAveChainSlug } from "../../domain/provider-chains.mjs";
import { recordProviderRequest } from "./provider-metrics.mjs";

export interface Candle {
  time: number;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export class AveError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AveError";
  }
}

export class AveSessionRequiredError extends Error {
  readonly deferred = true;
  readonly delay = 300;
  constructor(message: string) {
    super(message);
    this.name = "AveSessionRequiredError";
  }
}

type Json = Record<string, any>;
const scheduler = new RequestScheduler("ave", 3, 3, 20_000, 1);
const AVE_LOGO_BASE = "https://www.iconaves.com/";

function positive(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function finite(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function canonicalAveChain(value: string | null | undefined): string {
  const chain = tokenChainKey(value);
  return chain === "solana" ? "sol" : chain;
}

function aveChain(value: string): string {
  const chain = canonicalAveChain(value);
  if (!isAveChainSlug(chain)) throw new Error(`AVE 链名称无效：${chain}`);
  return chain === "sol" ? "solana" : chain;
}

function logoUrl(value: unknown): string | undefined {
  const path = text(value);
  if (!path) return undefined;
  if (/^https?:\/\//i.test(path)) return path;
  if (/^data:/i.test(path)) return path;
  return new URL(path.replace(/^\/+/, ""), AVE_LOGO_BASE).href;
}

function decode(result: AveQueryResult): Json | null {
  if (result.status === 0) {
    const message = result.error || "AVE 请求失败";
    if (/AVE.*(登录|请求模板|未就绪)|请求模板.*AVE|session|template/i.test(message)) throw new AveSessionRequiredError(message);
    throw new AveError(0, `AVE 请求失败：${message}`);
  }
  if (result.status === 429) throw new ApiRateLimitError(undefined, "AVE HTTP 429");
  if (result.status === 401 || result.status === 403) throw new ApiAccessBlockedError(`AVE HTTP ${result.status}`);
  if (result.status !== 200) throw new AveError(result.status, `AVE HTTP ${result.status}`);
  let payload: Json;
  try { payload = JSON.parse(result.body) as Json; }
  catch { throw new AveError(200, "AVE 返回的内容不是 JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AveError(200, "AVE JSON 外层格式无效");
  if (Number(payload.status) !== 1) {
    const message = text(payload.msg) || text(payload.message) || "接口未返回有效数据";
    if (/token detail 请求模板|登录窗口|登录会话/i.test(message)) throw new AveSessionRequiredError(message);
    return null;
  }
  return payload;
}

function parseMarket(payload: Json | null, result: AveQueryResult, expectedChain: string, expectedAddress: string): Market | null {
  const data = payload?.data;
  if (!data || typeof data !== "object") return null;
  const token = (data.token && typeof data.token === "object" ? data.token : data) as Json;
  const rawAddress = text(token.token) || text(token.address) || text(token.contract_address);
  const address = rawAddress || result.address;
  if (normalizeTokenAddress(address) !== normalizeTokenAddress(expectedAddress)) return null;
  const chain = canonicalAveChain(text(token.chain) || result.chain);
  if (chain !== canonicalAveChain(expectedChain)) return null;

  const price = positive(token.current_price_usd) ?? positive(token.price_usd) ?? positive(token.price);
  const totalSupply = positive(token.total) ?? positive(token.total_supply);
  const circulatingSupply = positive(token.circulating_supply) ?? positive(token.circulatingSupply);
  const directMcValue = positive(token.market_cap) ?? positive(token.marketCap);
  const directMc = directMcValue !== undefined && price !== undefined && directMcValue > price * 100 && directMcValue <= MAX_PLAUSIBLE_MARKET_CAP_USD
    ? directMcValue : undefined;
  const derivedMc = price !== undefined && (circulatingSupply ?? totalSupply) !== undefined
    ? price * (circulatingSupply ?? totalSupply)! : undefined;
  const mc = directMc ?? (derivedMc !== undefined && derivedMc > price! * 100 && derivedMc <= MAX_PLAUSIBLE_MARKET_CAP_USD ? derivedMc : undefined);
  const directFdv = positive(token.fdv);
  const derivedFdv = price !== undefined && totalSupply !== undefined ? price * totalSupply : undefined;
  const fdv = directFdv ?? (derivedFdv !== undefined && derivedFdv <= MAX_PLAUSIBLE_MARKET_CAP_USD ? derivedFdv : undefined);
  const pairRows = Array.isArray(data.pairs) ? data.pairs as Json[] : [];
  const mainPair = pairRows.find((pair) => text(pair.pair)?.toLowerCase() === text(token.main_pair)?.toLowerCase())
    ?? pairRows.find((pair) => text(pair.target_token) && normalizeTokenAddress(String(pair.target_token)) === normalizeTokenAddress(expectedAddress));
  const updated = positive(mainPair?.updated_at) ?? positive(token.updated_at);
  const quoteAt = updated === undefined ? undefined : Math.floor(updated >= 1e12 ? updated / 1000 : updated);
  const now = Math.floor(Date.now() / 1000);

  return {
    symbol: text(token.symbol),
    name: text(token.name) ?? text(token.token_name),
    logo: logoUrl(token.logo_url ?? token.logo),
    chain,
    price,
    mc: plausibleMarketCap(mc,fdv) ? mc : undefined,
    fdv,
    circulatingSupply,
    poolId: text(token.main_pair) ?? text(mainPair?.pair),
    quoteAt,
    receivedAt: now,
    timePrecision: "request",
    endpoint: result.endpoint,
    mcSource: mc === undefined ? undefined : "ave",
    mcBasis: mc === undefined ? undefined : directMc !== undefined ? "provider-reported" : "supply-derived",
    liq: positive(token.main_pair_tvl) ?? positive(token.tvl) ?? positive(mainPair?.tvl),
    change5m: finite(token.token_price_change_5m) ?? finite(mainPair?.price_change_5m),
    change1h: finite(token.token_price_change_1h) ?? finite(mainPair?.price_change_1h),
    change24h: finite(token.token_price_change_24h) ?? finite(token.price_change_24h) ?? finite(mainPair?.price_change_24h),
    holders: positive(token.holders) ?? positive(token.holder_count),
    source: "ave",
    updatedAt: now,
  };
}

function requestedAddress(chain: string, address: string): string {
  const value = normalizeTokenAddress(address);
  if (chain === "sol") {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new Error("AVE Solana 地址格式无效");
  } else if (!/^0x[\da-f]{40}$/i.test(value)) throw new Error("AVE EVM 地址格式无效");
  return value;
}

/** Query AVE through the authenticated AVE page session kept by Electron. */
export async function tokenInfo(bridge: Bridge, chain: string, address: string, priority: RequestPriority = "background"): Promise<Market | null> {
  const route = canonicalAveChain(chain);
  const wireChain = aveChain(route);
  const tokenAddress = requestedAddress(route, address);
  return scheduler.run(`detail:${route}:${tokenAddress}`, priority, async (requestSignal) => {
    let result: AveQueryResult;
    try {
      result = await bridge.aveQuery({ chain: wireChain, address: tokenAddress, mode: "detail" }, requestSignal);
      recordProviderRequest("ave", "token_info", result.status === 200);
    }
    catch (error) {
      recordProviderRequest("ave", "token_info", false);
      const message = error instanceof Error ? error.message : String(error);
      if (/AVE.*(登录|请求模板|未就绪)|请求模板.*AVE/i.test(message)) throw new AveSessionRequiredError(message);
      throw error;
    }
    return parseMarket(decode(result), result, route, tokenAddress);
  }, 0, { bucket: "ave-session", intervalMs: priority === "live" ? 75 : 300 });
}

function timestamp(value: unknown): number | undefined {
  const number = finite(value);
  if (number === undefined || number <= 0) return undefined;
  return Math.floor(number >= 1e12 ? number / 1000 : number);
}

/** Read historical price candles from AVE's own authenticated site session. */
export async function candles(
  bridge: Bridge,
  chain: string,
  address: string,
  fromSec: number,
  toSec: number,
  intervalSeconds: number,
  priority: RequestPriority = "background",
  signal?: AbortSignal,
): Promise<Candle[]> {
  const route = canonicalAveChain(chain);
  const wireChain = aveChain(route);
  const tokenAddress = requestedAddress(route, address);
  if (!Number.isSafeInteger(fromSec) || !Number.isSafeInteger(toSec) || fromSec < 0 || toSec <= fromSec) throw new Error("AVE K 线时间范围无效");
  if (![60, 300, 900, 1800, 3600, 7200, 14400, 86400].includes(intervalSeconds)) throw new Error("AVE K 线间隔不支持");
  return scheduler.run(`kline:${route}:${tokenAddress}:${intervalSeconds}:${fromSec}:${toSec}`, priority, async (requestSignal) => {
    let result: AveQueryResult;
    try {
      result = await bridge.aveQuery({ chain: wireChain, address: tokenAddress, mode: "kline", interval: intervalSeconds, from: fromSec, to: toSec }, requestSignal);
      recordProviderRequest("ave", "kline", result.status === 200);
    }
    catch (error) {
      recordProviderRequest("ave", "kline", false);
      const message = error instanceof Error ? error.message : String(error);
      if (/AVE.*(登录|请求模板|未就绪)|请求模板.*AVE/i.test(message)) throw new AveSessionRequiredError(message);
      throw error;
    }
    // AVE uses HTTP 400 for a valid query whose candle table has no rows.
    // Treat that specific response as an empty result so the acquisition job
    // can apply its one delayed no-data retry instead of being marked failed.
    if (result.status === 400) {
      try {
        const body = JSON.parse(result.body) as Json;
        const message = text(body.msg) || text(body.message) || text(body.error) || "";
        if (/no rows in result set|没有(?:行情|数据|记录)|暂无(?:行情|数据|K线)/i.test(message)) return [];
      } catch {}
    }
    const payload = decode(result);
    if (!payload) return [];
    const rows = payload.data?.kline_data ?? payload.data?.list ?? payload.data?.klines;
    if (!Array.isArray(rows)) throw new AveError(200, "AVE K 线字段缺失");
    const unique = new Map<number, Candle>();
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Json;
      const time = timestamp(row.t ?? row.time ?? row.timestamp);
      const open = positive(row.o ?? row.open) ?? positive(row.c ?? row.close);
      const close = positive(row.c ?? row.close);
      const high = positive(row.h ?? row.high);
      const low = positive(row.l ?? row.low);
      if (time === undefined || time < fromSec || time >= toSec || open === undefined || close === undefined || high === undefined || low === undefined || low > Math.min(open, close) || high < Math.max(open, close)) continue;
      unique.set(time, { time, open, close, high, low, volume: positive(row.v ?? row.volume) ?? 0 });
    }
    return [...unique.values()].sort((a, b) => a.time - b.time);
  }, 0, { bucket: "ave-session", intervalMs: 300, signal });
}


