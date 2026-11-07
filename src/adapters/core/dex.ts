import { plausibleMarketCap } from "./quote-contract.js";
import { requestJson } from "./proxy.js";
import type { Market } from "./types.js";
import { normalizeTokenAddress, tokenChainKey } from "./identity.js";
import { ApiRateLimitError, RequestScheduler, type RequestPriority } from "./request-scheduler.js";
import { recordProviderRequest } from "./provider-metrics.mjs";

export const DEX_BATCH = 30;
const ROOT = "https://api.dexscreener.com";
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_SAFE_USD = 1e15;
// Regular traffic uses at most three slots; new calls retain the fourth.
export const dexRequestGate = new RequestScheduler("dexscreener", 3, 4, 60_000, 2);
const scheduler = dexRequestGate;
export const dexRequestWait = () => scheduler.waitStatus;

type Pair = {
  chainId?: unknown;
  pairAddress?: unknown;
  baseToken?: { address?: unknown; symbol?: unknown; name?: unknown };
  info?: { imageUrl?: unknown };
  priceUsd?: unknown;
  marketCap?: unknown;
  fdv?: unknown;
  liquidity?: { usd?: unknown };
  priceChange?: { m5?: unknown; h1?: unknown; h24?: unknown };
};

function finite(value: unknown): number | undefined {
  const result = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? result : undefined;
}

function positive(value: unknown): number | undefined {
  const result = finite(value);
  return result !== undefined && result > 0 ? result : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const DEX_CHAIN_ALIASES: Record<string, string> = {
  ethereum: "eth",
  "binance-smart-chain": "bsc",
  "bnb-chain": "bsc",
  solana: "sol",
};

export const Chain = {
  toDex(chain: string): string {
    const key = tokenChainKey(chain);
    if (key === "eth") return "ethereum";
    if (key === "sol") return "solana";
    return key;
  },
  fromDex(chain: string): string {
    const key = chain.trim().toLowerCase();
    return DEX_CHAIN_ALIASES[key] ?? key;
  },
};

function pairChain(pair: Pair): string | undefined {
  const value = text(pair.chainId);
  return value ? tokenChainKey(Chain.fromDex(value)) : undefined;
}

function belongsToAddress(pair: Pair, expected: string): boolean {
  const returned = text(pair.baseToken?.address);
  return !!returned && normalizeTokenAddress(returned) === expected;
}

function liquidity(pair: Pair): number {
  return positive(pair.liquidity?.usd) ?? 0;
}

function hasUsablePrice(pair: Pair): boolean {
  return !!pairChain(pair) && positive(pair.priceUsd) !== undefined;
}

type PairSelection = { pair: string; switchedAt: number; candidate?: string; candidateSince?: number };
const selectedPairs = new Map<string, PairSelection>();
function poolId(pair: Pair): string { const id=String(pair.pairAddress);return pairChain(pair)==='sol'?id:id.toLowerCase(); }

export function restorePairSelection(chain: string, address: string, pair: string, selections = selectedPairs, at = Date.now()): void {
  const key=`${tokenChainKey(chain)}:${normalizeTokenAddress(address)}`;
  if(!pair||selections.has(key))return;
  selections.set(key,{pair:tokenChainKey(chain)==='sol'?pair:pair.toLowerCase(),switchedAt:at});
  while(selections.size>5000)selections.delete(selections.keys().next().value!);
}

/** Retain the main pool through small liquidity changes; switch only after sustained improvement. */
export function choosePair(pairs: Pair[], selections = selectedPairs, at = Date.now()): Pair | undefined {
  const candidates=pairs.filter(hasUsablePrice).sort((a,b)=>liquidity(b)-liquidity(a)||String(a.pairAddress).localeCompare(String(b.pairAddress)));
  const best=candidates[0];if(!best)return undefined;
  if(!text(best.pairAddress)||!text(best.baseToken?.address))return best;
  const key=`${pairChain(best)}:${normalizeTokenAddress(text(best.baseToken?.address) || '')}`;
  const state=selections.get(key),current=state?candidates.find(p=>poolId(p)===state.pair):undefined;
  const select=(pair:Pair)=>{selections.set(key,{pair:poolId(pair),switchedAt:at});while(selections.size>5000)selections.delete(selections.keys().next().value!);return pair;};
  if(!state||!current||liquidity(current)<=0)return select(best);
  if(poolId(best)===poolId(current)||liquidity(best)<liquidity(current)*1.5){delete state.candidate;delete state.candidateSince;return current;}
  if(state.candidate!==poolId(best)){state.candidate=poolId(best);state.candidateSince=at;return current;}
  if(at-Number(state.candidateSince)<30_000||at-state.switchedAt<60_000)return current;
  return select(best);
}

const pairReceivedAt = new WeakMap<object, number>();
const quoteCache = new Map<string, {at: number; market: Market}>();
const QUOTE_REUSE_MS = 3000;
function cachedQuote(chain: string,address: string): Market | undefined {
  const key=`${tokenChainKey(chain)}:${normalizeTokenAddress(address)}`,entry=quoteCache.get(key);
  if(!entry)return;
  if(Date.now()-entry.at>=QUOTE_REUSE_MS){quoteCache.delete(key);return;}
  return {...entry.market};
}
function rememberResponse(url: string,response: unknown): void {
  const path=new URL(url).pathname.split('/').filter(Boolean);
  let pairs: Pair[],addresses: string[],expected: string | undefined;
  if(path[0]==='latest'&&path[1]==='dex'&&path[2]==='tokens'){
    addresses=[normalizeTokenAddress(decodeURIComponent(path[3]||''))];
    pairs=Array.isArray((response as {pairs?: Pair[]})?.pairs)?(response as {pairs: Pair[]}).pairs:[];
  }else if(path[0]==='tokens'&&path[1]==='v1'){
    expected=tokenChainKey(Chain.fromDex(decodeURIComponent(path[2]||'')));
    addresses=decodeURIComponent(path[3]||'').split(',').map(normalizeTokenAddress);
    pairs=Array.isArray(response)?response:[];
  }else return;
  const at=Date.now(),requested=new Set(addresses),grouped=new Map<string,Pair[]>();
  // Only exact requested tokens can seed a later quote; chains and Solana case remain isolated.
  for(const pair of pairs){
    const address=text(pair.baseToken?.address),chain=pairChain(pair);
    if(!address||!chain||!requested.has(normalizeTokenAddress(address))||(expected&&expected!==chain))continue;
    pairReceivedAt.set(pair,Math.floor(at/1000));
    const key=`${chain}:${normalizeTokenAddress(address)}`,list=grouped.get(key)||[];list.push(pair);grouped.set(key,list);
  }
  if(expected)for(const address of addresses)quoteCache.delete(`${expected}:${address}`);
  for(const [key,list] of grouped){const pair=choosePair(list);if(pair)quoteCache.set(key,{at,market:toMarket(pair)});}
  for(const [key,value] of quoteCache)if(at-value.at>=QUOTE_REUSE_MS)quoteCache.delete(key);
  while(quoteCache.size>1000)quoteCache.delete(quoteCache.keys().next().value!);
}

function toMarket(pair: Pair): Market {
  const chain = pairChain(pair);
  const mc = positive(pair.marketCap);
  const fdv = positive(pair.fdv);
  const cap = mc !== undefined && mc <= MAX_SAFE_USD && plausibleMarketCap(mc,fdv) ? mc : undefined;
  const fullyDiluted = fdv !== undefined && fdv <= MAX_SAFE_USD ? fdv : undefined;
  const updatedAt = pairReceivedAt.get(pair) ?? Math.floor(Date.now() / 1000);
  return {
    symbol: text(pair.baseToken?.symbol),
    name: text(pair.baseToken?.name),
    logo: text(pair.info?.imageUrl),
    chain,
    price: positive(pair.priceUsd),
    mc: cap,
    fdv: fullyDiluted,
    poolId: text(pair.pairAddress),
    mcSource: cap === undefined ? undefined : "dex",
    mcBasis: cap === undefined ? undefined : "provider-reported",
    receivedAt: updatedAt,
    timePrecision: "request",
    endpoint: "DexScreener token pairs",
    liq: liquidity(pair),
    change5m: finite(pair.priceChange?.m5),
    change1h: finite(pair.priceChange?.h1),
    change24h: finite(pair.priceChange?.h24),
    source: "dex",
    updatedAt,
  };
}

async function getJson<T>(url: string, priority: RequestPriority, strict = false): Promise<T | null> {
  return scheduler.run(url, priority, async (signal) => {
    let response;
    try {
      response = await requestJson(url, { timeoutMs: REQUEST_TIMEOUT_MS, signal });
    } catch (error) {
      recordProviderRequest("dex", "market_data", false);
      throw error;
    }
    recordProviderRequest("dex", "market_data", response.status >= 200 && response.status < 300);
    if (response.status === 429)
      throw new ApiRateLimitError(response.retryAfterMs, "DexScreener HTTP 429");
    if (response.status < 200 || response.status >= 300) {
      if (strict) throw Object.assign(new Error(`DexScreener HTTP ${response.status}`), { status: response.status });
      return null;
    }
    if(response.status>=200&&response.status<300)rememberResponse(url,response.json);
    return response.json as T | null;
  }, 3_000, { bucket: "dexscreener", intervalMs: 250 });
}

async function exactTokenPairs(address: string, priority: RequestPriority, strict = false): Promise<Pair[]> {
  const target = normalizeTokenAddress(address);
  const response = await getJson<{ pairs?: Pair[] }>(
    `${ROOT}/latest/dex/tokens/${encodeURIComponent(address.trim())}`,
    priority,
    strict,
  );
  return (Array.isArray(response?.pairs) ? response.pairs : [])
    .filter((pair) => belongsToAddress(pair, target));
}

function uniqueAddresses(addresses: string[]): string[] {
  return [...new Set(addresses.map((address) => normalizeTokenAddress(address)))];
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/** Public pair lookup; only a unique chain and an exact base-token address are accepted. */
export const Dex = {
  restorePairSelection,
  isMarketUsable(market: Market): boolean {
    return positive(market.price) !== undefined;
  },

  /** One exact-address lookup for display only; a unique chain is required and this never verifies the token. */
  async lookupMetadata(
    address: string,
    priority: RequestPriority = "background",
  ): Promise<Pick<Market, "chain" | "symbol" | "name" | "logo"> | null> {
    const candidates = await exactTokenPairs(address, priority);
    const chains = [...new Set(candidates.map(pairChain).filter((chain): chain is string => !!chain))];
    if (chains.length !== 1) return null;
    const chain = chains[0];
    const pairs = candidates.filter((pair) => pairChain(pair) === chain).sort((a, b) => liquidity(b) - liquidity(a));
    const symbol = pairs.map((pair) => text(pair.baseToken?.symbol)).find(Boolean) || "";
    const name = pairs.map((pair) => text(pair.baseToken?.name)).find(Boolean) || "";
    const logo = pairs.map((pair) => text(pair.info?.imageUrl)).find(Boolean) || "";
    if (!symbol && !name && !logo) return null;
    return { chain, symbol, name, logo };
  },

  async lookupChains(address: string, priority: RequestPriority = "background"): Promise<string[]> {
    const candidates = await exactTokenPairs(address, priority, true);
    return [...new Set(candidates.map(pairChain).filter((chain): chain is string => !!chain))];
  },

  async lookup(
    address: string,
    priority: RequestPriority = "live",
    expectedChain?: string,
  ): Promise<Market | null> {
    const expected = expectedChain ? tokenChainKey(expectedChain) : undefined;
    if(expected){const cached=cachedQuote(expected,address);if(cached)return cached;}
    const candidates = (await exactTokenPairs(address, priority, true))
      .filter((pair) => hasUsablePrice(pair) && (!expected || pairChain(pair) === expected));
    const chains = new Set(candidates.map(pairChain));
    if (expected ? !candidates.length : chains.size !== 1) return null;
    const selected = choosePair(candidates);
    return selected ? toMarket(selected) : null;
  },

  /** Same-chain batches are automatically split at the provider's 30-address limit. */
  async batch(dexChain: string, addresses: string[], priority: RequestPriority = "live"): Promise<Map<string, Market>> {
    const chain = tokenChainKey(Chain.fromDex(dexChain));
    const targets = uniqueAddresses(addresses);
    const out = new Map<string, Market>();
    const missing=targets.filter(address=>{const cached=cachedQuote(chain,address);if(cached){out.set(address,cached);return false;}return true;});
    for (const batch of chunks(missing, DEX_BATCH)) {
      const response = await getJson<Pair[]>(
        `${ROOT}/tokens/v1/${encodeURIComponent(Chain.toDex(chain))}/${batch.map(encodeURIComponent).join(",")}`,
        priority,
      );
      if (!Array.isArray(response)) continue;
      const requested = new Set(batch);
      const byAddress = new Map<string, Pair[]>();
      for (const pair of response) {
        const raw = text(pair.baseToken?.address);
        const address = raw ? normalizeTokenAddress(raw) : undefined;
        if (!address || !requested.has(address) || pairChain(pair) !== chain || !hasUsablePrice(pair)) continue;
        const list = byAddress.get(address) ?? [];
        list.push(pair);
        byAddress.set(address, list);
      }
      for (const [address, pairs] of byAddress) {
        const selected = choosePair(pairs);
        if (selected) out.set(address, toMarket(selected));
      }
    }
    return out;
  },

  /** Display metadata can be returned when the selected pair has no usable quote. */
  async batchMetadata(
    dexChain: string,
    addresses: string[],
    priority: RequestPriority = "background",
  ): Promise<Map<string, Pick<Market, "chain" | "symbol" | "name" | "logo">>> {
    const chain = tokenChainKey(Chain.fromDex(dexChain));
    const targets = uniqueAddresses(addresses);
    const result = new Map<string, Pick<Market, "chain" | "symbol" | "name" | "logo">>();
    const missing=targets.filter(address=>{
      const cached=cachedQuote(chain,address);if(!cached)return true;
      if(cached.symbol||cached.name||cached.logo)result.set(address,{chain,symbol:cached.symbol,name:cached.name,logo:cached.logo});
      return false;
    });
    const requested = new Set(missing);
    const pairs: Pair[] = [];
    for (const batch of chunks(missing, DEX_BATCH)) {
      const response = await getJson<Pair[]>(
        `${ROOT}/tokens/v1/${encodeURIComponent(Chain.toDex(chain))}/${batch.map(encodeURIComponent).join(",")}`,
        priority,
      );
      if (Array.isArray(response)) pairs.push(...response);
    }
    const grouped = new Map<string, Pair[]>();
    for (const pair of pairs) {
      const address = text(pair.baseToken?.address);
      const normalized = address ? normalizeTokenAddress(address) : undefined;
      if (!normalized || !requested.has(normalized) || pairChain(pair) !== chain) continue;
      const list = grouped.get(normalized) ?? [];
      list.push(pair);
      grouped.set(normalized, list);
    }
    for (const [address, candidates] of grouped) {
      candidates.sort((a, b) => liquidity(b) - liquidity(a));
      const best = candidates[0];
      const metadata = {
        chain,
        symbol: text(best.baseToken?.symbol),
        name: text(best.baseToken?.name),
        logo: text(best.info?.imageUrl),
      };
      if (metadata.symbol || metadata.name || metadata.logo) result.set(address, metadata);
    }
    return result;
  },
};
