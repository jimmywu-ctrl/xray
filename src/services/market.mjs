import { tokenInfo as aveTokenInfo, candles as aveCandles, AveSessionRequiredError } from "../adapters/core/ave.ts";
import { Dex, Chain } from "../adapters/core/dex.ts";
import { auditEvmWalletAddress, Erc20 } from "../adapters/core/erc20.ts";
import { auditSolanaWalletAddress, checkSolanaMint, isSolanaPublicKey } from "../adapters/core/solana-mint.ts";
import { takeProviderRequestMetrics } from "../adapters/core/provider-metrics.mjs";
import { usableAvatarUrl } from './avatar-policy.mjs';
import {sanitizeMarketQuote} from '../adapters/core/quote-contract.ts';
import {resumeAutomaticAfterManual} from './manual-repair-resume.mjs';
import {PriceAcquisition} from './price-acquisition.mjs';
import { isAveChainSlug } from '../domain/provider-chains.mjs';
import {
  now,
  RECENT_WINDOW_SEC,
  CAPTURE_QUIET_WINDOW_SEC,
  CAPTURE_REFRESH_INTERVAL_SEC,
  canonicalChain,
  positive,
  normalize,
  compatible,
  validPoint,
} from "../domain/rules.mjs";
import { DeferredError, WaitError, isTransientMarketError } from "../infra/worker.mjs";
/** Vanity suffixes of BSC launchpads (four.meme / flap etc.) — try BSC first and accept a BSC hit directly. */
const BSC_VANITY = /(?:7777|4444|8888|ffff|eeee)$/i;
/** A shout stays in the live overlay while it has activity; quotes themselves remain in memory. */
export const LIVE_ACTIVITY_WINDOW_SEC = RECENT_WINDOW_SEC;
const LIVE_HIGH_TTL_SEC = RECENT_WINDOW_SEC;
const LIVE_HIGH_LIMIT = 5000;
const LOGO_LOOKUP_CONCURRENCY = 1;
const LOGO_LOOKUP_MAX_ATTEMPTS = 4;
const HISTORICAL_METADATA_SCAN_MS = 10_000;
const HISTORICAL_METADATA_PAGE_SIZE = 50;
const LOGO_LOOKUP_RETRY_SEC = [300, 1800, 7200, 21600];
// DEX is the live quote source; AVE fills missing price or market-cap fields.
const LIVE_QUOTE_PROVIDERS = ['dex', 'ave'];
const LIVE_QUOTE_MAX_ACTIVE = 40;
const LIVE_SUPPLEMENT_RETRY_MS = 15_000;
const LIVE_SUPPLEMENT_CACHE_MS = 45_000;
const LIVE_OVERLAY_DEX_REFRESH_MS = 3_000;
const LIVE_QUOTE_PERSIST_INTERVAL_MS = 60_000;
const LIVE_PROVIDER_FAILURE_LIMIT = 3;
const NO_DATA_RECHECK_INTERVAL_SEC = 30 * 60;
const NO_DATA_RECHECK_SCAN_INTERVAL_SEC = 15 * 60;
const NO_DATA_RECHECK_BATCH_SIZE = 2;
const NO_DATA_RECHECK_MAX_ATTEMPTS = 4;
const LIVE_OVERLAY_QUOTE_FIELDS = ['price', 'mc', 'fdv', 'liq', 'change5m', 'change1h', 'change24h'];
const BACKGROUND_METADATA_PROVIDERS = ['dex', 'ave'];
const METADATA_FIELDS = ['symbol', 'name', 'logo', 'liq', 'holders'];
const METADATA_LOOKUP_RETRY_SEC = [300];
const METADATA_LOOKUP_MAX_ATTEMPTS = 2;

function usableLogo(value) {
  return usableAvatarUrl(value);
}

function missingMetadata(field, value) {
  if (field === 'logo') return !usableLogo(value);
  if (['circulatingSupply', 'liq', 'holders'].includes(field)) return !positive(value);
  return typeof value !== 'string' || !value.trim();
}

function usableQuoteField(field, value) {
  if (['symbol', 'name'].includes(field)) return typeof value === 'string' && !!value.trim();
  if (field === 'logo') return usableLogo(value);
  if (['change5m', 'change1h', 'change24h'].includes(field)) return value != null && value !== '' && Number.isFinite(Number(value));
  // rules.positive returns null for absent or invalid numeric values.
  return positive(value) != null;
}

function hasFreshAveField(entry, field, maxAgeMs) {
  const source = entry?.quote?.fieldSources?.[field];
  const ageMs = Date.now() - Number(source?.at || 0) * 1000;
  return source?.provider === 'ave' && ageMs >= 0 && ageMs < maxAgeMs && usableQuoteField(field, entry?.quote?.[field]);
}

export function mergeLiveQuote(primary, supplement, previous, { preferAve = false } = {}) {
  primary=sanitizeMarketQuote(primary);supplement=sanitizeMarketQuote(supplement);
  if(previous?.quote)previous={...previous,quote:sanitizeMarketQuote(previous.quote)};
  const fields = ['price', 'mc', 'fdv', 'liq', 'change5m', 'change1h', 'change24h', 'symbol', 'name', 'logo'];
  const quote = { ...(primary || {}) };
  const fieldSources = {};
  const primarySource = primary?.provider || 'dex';
  const supplementSource = supplement?.provider || 'ave';
  const receivedAt = Math.floor(Date.now() / 1000);
  for (const field of fields) {
    // A fresh primary quote wins; supplementary and cached fields retain their own timestamps.
    if (preferAve && LIVE_OVERLAY_QUOTE_FIELDS.includes(field) && supplementSource === 'ave' && usableQuoteField(field, supplement?.[field])) {
      quote[field] = supplement[field];
      fieldSources[field] = { provider: supplementSource, at: receivedAt, quoteAt: supplement.quoteAt || supplement.receivedAt || receivedAt };
      continue;
    }
    if (preferAve && LIVE_OVERLAY_QUOTE_FIELDS.includes(field) && hasFreshAveField(previous, field, LIVE_SUPPLEMENT_CACHE_MS)) {
      quote[field] = previous.quote[field];
      fieldSources[field] = previous.quote.fieldSources[field];
      continue;
    }
    if (usableQuoteField(field, quote[field])) {
      fieldSources[field] = primary?.fieldSources?.[field] || { provider: primarySource, at: receivedAt, quoteAt: primary?.quoteAt || primary?.receivedAt || receivedAt };
      continue;
    }
    if (usableQuoteField(field, supplement?.[field])) {
      quote[field] = supplement[field];
      fieldSources[field] = { provider: supplementSource, at: receivedAt, quoteAt: supplement.quoteAt || supplement.receivedAt || receivedAt };
      continue;
    }
    const oldSource = previous?.quote?.fieldSources?.[field];
    if (oldSource?.provider === 'ave' && Date.now() - Number(oldSource.at || 0) * 1000 <= LIVE_SUPPLEMENT_CACHE_MS && usableQuoteField(field, previous.quote[field])) {
      quote[field] = previous.quote[field];
      fieldSources[field] = oldSource;
    }
  }
  quote.fieldSources = fieldSources;
  quote.provider = fieldSources.price?.provider || (positive(primary?.price) ? 'dex' : positive(supplement?.price) ? supplementSource : primarySource);
  quote.source = quote.provider;
  if (fieldSources.mc && fieldSources.mc.provider !== 'dex') {
    quote.mcSource = fieldSources.mc.provider;
    quote.mcBasis = supplement?.mcBasis || previous?.quote?.mcBasis || 'provider-reported';
    quote.mcQuoteAt = fieldSources.mc.quoteAt || fieldSources.mc.at;
  } else if (usableQuoteField('mc', quote.mc)) {
    quote.mcSource = fieldSources.mc?.provider || primarySource;
    quote.mcBasis = primary?.mcBasis || 'provider-reported';
    quote.mcQuoteAt = fieldSources.mc?.quoteAt || fieldSources.mc?.at;
  }
  return quote;
}

export function primaryDexQuote(previous) {
  if (!previous) return null;
  previous=sanitizeMarketQuote(previous);
  const quote = { ...previous, provider: 'dex', source: 'dex', fieldSources: { ...previous.fieldSources } };
  for (const field of ['price', 'mc', 'fdv', 'liq', 'change5m', 'change1h', 'change24h', 'symbol', 'name', 'logo']) {
    const source = previous.fieldSources?.[field];
    if ((source?.provider || previous.provider) !== 'dex' ||
        Date.now() - Number(source?.at || previous.receivedAt || 0) * 1000 > LIVE_SUPPLEMENT_CACHE_MS) {
      delete quote[field]; delete quote.fieldSources[field];
    } else if (!source && usableQuoteField(field, quote[field])) {
      quote.fieldSources[field] = { provider: 'dex', at: previous.receivedAt, quoteAt: previous.quoteAt || previous.receivedAt };
    }
  }
  return quote;
}
export class MarketService {
  constructor(repo, bridge, statistics, ingestion, changed = () => {}) {
    this.repo = repo;
    this.priceAcquisition=new PriceAcquisition(this);
    this.bridge = bridge;
    this.statistics = statistics;
    this.ingestion = ingestion;
    this.changed = changed;
    this.visible = new Set();
    this.active = new Map();
    this.generation = new Map();
    this.liveProviderFailures = new Map();
    this.aveSupplementRetryAt = new Map();
    this.aveLiveSupplementBusy = false;
    this.aveLiveSupplementBackoffUntil = 0;
    this.aveLiveSupplementQueue = new Map();
    /** Fast live cache; a throttled copy is kept in SQLite for immediate stale-first rendering. */
    this.live = new Map();
    this.quotePersistedAt = new Map();
    /** Bounded, short-lived highs survive overlay expiry until one archive query consumes them. */
    this.liveHighs = new Map();
    /** Logo lookup runs separately from live quotes and only processes one token at a time. */
    this.logoActive = new Set();
    this.metadataActive = new Set();
    this.visibleMetadataActive = new Set();
    this.visibleMetadataRetryAt = new Map();
    this.quoteRequests = new Map();
    this.quoteCache = new Map();
    this.lastPeakRefreshScan = 0;
    this.lastNoDataRetryScan = 0;
    this.historicalMetadataCursor = 0;
    this.lastHistoricalMetadataScan = 0;
    this.lastChainFallbackScan = 0;
    /** Coalesce the eager address probe with the later capture worker request. */
    this.chainResolutionActive = new Map();
    this.walletAuditBusy = false;
    /** Unknown EVM tokens that need priority chain audits after market lookups fail. */
    this.walletAuditPriority = new Set();
    this.lastEphemeralStateCleanup = 0;
    this.inventory = new Map();
    this.inventoryDirty = true;
    this.lastInventoryReconcile = 0;
    this.stopped = false;
    this.providerMetricsTimer = null;
    this.resetLogoBackoffForExpandedScan();
    // Injectable for tests; production uses the project's existing adapters.
    this.chainProbes = {
      dex: (address) => Dex.lookupChains(address, "background"),
      avePageSearch: (address, signal) => this.bridge.aveSearchAddress({ address }, signal),
    };
  }
  alive(){return !this.stopped&&this.repo.db?.open!==false;}
  /** Start the existing chain check as soon as a new address is ingested. */
  prefetchUnknownChains(addresses = []) {
    const unique = [...new Set(addresses)].slice(0, 10);
    for (const address of unique) {
      const active = this.repo.get(`
        SELECT 1 FROM tokens t JOIN claims c USING(chain,address)
        WHERE t.chain='?' AND t.address=? AND t.blocked=0 AND c.active=1 LIMIT 1
      `, address);
      if (!active) continue;
      void this.resolveUnknownChain(address).catch((error) => {
        this.repo.diagnostic('token_probe', `?:${address}`, `优先定链失败：${String(error?.message ?? error).slice(0, 250)}`);
      });
    }
  }
  prioritizeUnknownWalletAudit(address) {
    if (!/^0x[\da-f]{40}$/i.test(address)) return;
    const row = this.repo.get(`
      SELECT t.address FROM tokens t JOIN claims c USING(chain,address)
      WHERE t.chain='?' AND lower(t.address)=lower(?) AND t.blocked=0 AND t.verified=0 AND c.active=1
        AND COALESCE(json_extract(t.metadata,'$.manualDisposition'),'')<>'wallet'
        AND COALESCE(json_extract(t.metadata,'$.autoDisposition'),'') NOT IN ('wallet','unlisted')
      LIMIT 1
    `, address);
    if (!row) return;
    const key = row.address.toLowerCase();
    if (!this.walletAuditPriority.has(key) && this.walletAuditPriority.size >= 100)
      this.walletAuditPriority.delete(this.walletAuditPriority.values().next().value);
    this.walletAuditPriority.add(key);
    // Run now when the serial audit worker is idle; otherwise the priority set
    // makes this address the next eligible item after the current RPC check.
    void this.auditNextUnknownWallet();
  }
  /** Resolve one unknown address via AVE web search, then exact Dex lookup. */
  async resolveUnknownChain(address, guard = () => true, signal) {
    const inflightKey = /^0x[\da-f]{40}$/i.test(address) ? address.toLowerCase() : address;
    let pending = this.chainResolutionActive.get(inflightKey);
    if (!pending) {
      pending = this.resolveUnknownChainOnce(address, () => true, signal);
      this.chainResolutionActive.set(inflightKey, pending);
      void pending.finally(() => {
        if (this.chainResolutionActive.get(inflightKey) === pending) this.chainResolutionActive.delete(inflightKey);
      }).catch(() => {});
    }
    const result = await pending;
    return this.alive()&&guard() ? result : null;
  }
  async resolveUnknownChainOnce(address, guard = () => true, signal) {
    const callerGuard=guard;guard=()=>this.alive()&&callerGuard();
    if(!guard())return null;
    const probes = this.chainProbes, key = `?:${address}`;
    const isEvm = /^0x[\da-f]{40}$/i.test(address);
    const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    if (!isEvm && !isSol) return null;
    const knownRows = this.repo.all("SELECT chain,metadata FROM tokens WHERE address=? AND chain<>'?'", address);
    const knownChains = [...new Set(knownRows.map((row) => canonicalChain(row.chain)).filter((chain) => chain && chain !== "?"))];
    if (knownChains.length === 1) {
      const row = knownRows.find((item) => canonicalChain(item.chain) === knownChains[0]);
      return { chain: knownChains[0], via: "cached_identity" };
    }
    const unknown = this.repo.get("SELECT metadata FROM tokens WHERE chain='?' AND address=?", address);
    const metadata = JSON.parse(unknown?.metadata || "{}");
    const previousLookup = metadata.aveChainLookup;
    if (previousLookup?.status === "found" && previousLookup.chain)
      return { chain: canonicalChain(previousLookup.chain), via: previousLookup.via || "cached_identity" };
    const priorFallback = metadata.chainResolutionFallback || {};
    if (priorFallback.complete || Number(priorFallback.attempts || 0) >= 3)
      return { review: true, lookup: previousLookup || { status: "no_match" } };

    const saveMetadata = (update) => {
      const row = this.repo.get("SELECT metadata FROM tokens WHERE chain='?' AND address=?", address);
      if (!row) return;
      const next = JSON.parse(row.metadata || "{}");
      Object.assign(next, update);
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain='?' AND address=?", JSON.stringify(next), address);
    };
    const startedAt = now();
    if (Number(priorFallback.retryAt || 0) > startedAt)
      return { review: true, lookup: previousLookup || { status: "no_match" }, retryAt: priorFallback.retryAt };
    let webChains = [];
    let webCandidateChains = [];
    let webTokenFound = false;
    let webExactMatch = false;
    let webTruncatedMatch = false;
    let webCandidateCount = 0;
    let webCandidateDetails = [];
    let webDiagnostic = null;
    let dexChains = [];
    let webError = "";
    let dexError = "";

    if (priorFallback.avePage?.status === "found" && Array.isArray(priorFallback.avePage.chains)) {
      webChains = priorFallback.avePage.chains;
      webTokenFound = webExactMatch = webChains.length > 0;
    }
    else {
      try {
        const result = await probes.avePageSearch(address, signal);
        if (!guard()) return null;
        const resultChains = [...new Set((Array.isArray(result) ? result : result?.chains || [])
          .map((raw) => canonicalChain(typeof raw === "string" ? raw : raw?.chain))
          .filter((chain) => isAveChainSlug(chain)))];
        webExactMatch = Array.isArray(result) ? resultChains.length > 0 : Boolean(result?.exactAddress);
        webTruncatedMatch = !Array.isArray(result) && Boolean(result?.truncatedAddress);
        webTokenFound = Array.isArray(result) ? resultChains.length > 0 : Boolean(result?.tokenFound || webExactMatch || webTruncatedMatch);
        webCandidateCount = Number(Array.isArray(result) ? resultChains.length : result?.candidateCount || 0);
        webCandidateDetails = Array.isArray(result) ? [] : (Array.isArray(result?.candidateDetails) ? result.candidateDetails.slice(0, 16) : []);
        webDiagnostic = Array.isArray(result) ? null : result?.diagnostic || null;
        webChains = webExactMatch ? resultChains : [];
        webCandidateChains = webExactMatch ? [] : resultChains;
      } catch (error) {
        webError = String(error?.message ?? error).slice(0, 300);
        this.repo.diagnostic("token_probe", key, `ave_web: ${webError}; 转 Dex 继续核对`);
      }
    }
    if (webExactMatch && webChains.length === 1) {
      saveMetadata({ aveChainLookup: { status: "found", chain: webChains[0], via: "ave_web", at: startedAt }, chainResolutionFallback: { addressSearchVersion: 8, complete: true, avePage: { status: "found", chains: webChains, tokenFound: true, addressMatch: "exact", candidateCount: webCandidateCount }, dex: { status: "skipped" }, at: startedAt } });
      return { chain: webChains[0], via: "ave_web" };
    }

    if (priorFallback.dex?.status === "found" && Array.isArray(priorFallback.dex.chains)) dexChains = priorFallback.dex.chains;
    else {
      try {
        const result = await probes.dex(address);
        if (!guard()) return null;
        dexChains = [...new Set((Array.isArray(result) ? result : [])
          .map((raw) => canonicalChain(typeof raw === "string" ? raw : raw?.chain))
          .filter((chain) => isAveChainSlug(chain)))];
      } catch (error) {
        dexError = String(error?.message ?? error).slice(0, 300);
        this.repo.diagnostic("token_probe", key, `dex_chain: ${dexError}; 留待人工核对`);
      }
    }
    if (dexChains.length === 1 && (!webChains.length || (webChains.length === 1 && webChains[0] === dexChains[0]))) {
      const avePageStatus = webChains.length ? "found" : webTokenFound ? "token_found_no_chain" : webError ? "failed" : "no_match";
      saveMetadata({ aveChainLookup: { status: "found", chain: dexChains[0], via: "dex", at: startedAt }, chainResolutionFallback: { addressSearchVersion: 8, complete: true, avePage: { status: avePageStatus, chains: webChains, candidateChains: webCandidateChains, tokenFound: webTokenFound, addressMatch: webExactMatch ? "exact" : webTruncatedMatch ? "truncated" : "none", candidateCount: webCandidateCount, ...(webDiagnostic ? { diagnostic: webDiagnostic } : {}), ...(webError ? { error: webError } : {}) }, dex: { status: "found", chains: dexChains }, at: startedAt } });
      return { chain: dexChains[0], via: "dex" };
    }

    const allChains = [...new Set([...webChains, ...dexChains])];
    const finalLookup = { status: allChains.length ? "ambiguous" : webTokenFound ? "token_found" : "no_match", chains: allChains, tokenFound: webTokenFound, at: startedAt };
    const attempts = Number(priorFallback.attempts || 0) + 1;
    // Providers can index a new token at different times. A clean no-match on
    // the first pass is not conclusive, so recheck it once after a short delay.
    const retryNoMatch = finalLookup.status === "no_match" && attempts === 1;
    const retryable = Boolean(webError || dexError || retryNoMatch);
    // Transient provider failures stay in a durable, low-frequency retry lane.
    // The capped backoff avoids hammering AVE/Dex during a prolonged outage.
    const retryDelaySec = retryNoMatch ? 30 * 60 : attempts <= 1 ? 5 * 60 : attempts === 2 ? 30 * 60 : attempts === 3 ? 2 * 60 * 60 : 6 * 60 * 60;
    const avePageStatus = webChains.length ? "ambiguous" : webTokenFound ? "token_found_no_chain" : webError ? "failed" : "no_match";
    saveMetadata({ aveChainLookup: finalLookup, chainResolutionFallback: {
      addressSearchVersion: 8,
      complete: !retryable,
      attempts,
      ...(retryable ? { retryAt: startedAt + retryDelaySec } : {}),
      avePage: { status: avePageStatus, chains: webChains, candidateChains: webCandidateChains, tokenFound: webTokenFound, addressMatch: webExactMatch ? "exact" : webTruncatedMatch ? "truncated" : "none", candidateCount: webCandidateCount, ...(webCandidateDetails.length ? { candidateDetails: webCandidateDetails } : {}), ...(webDiagnostic ? { diagnostic: webDiagnostic } : {}), ...(webError ? { error: webError } : {}) },
      dex: { status: dexChains.length ? "ambiguous" : dexError ? "failed" : "no_match", chains: dexChains, ...(dexError ? { error: dexError } : {}) },
      at: startedAt,
    } });
    if (finalLookup.status === "no_match") this.ingestion.archiveUnknownCandidate(address);
    if (isEvm && finalLookup.status === "no_match") this.prioritizeUnknownWalletAudit(address);
    return { review: true, lookup: finalLookup };
  }
  handlers() {
    return {
      capture: (c) => this.capture(c),
    };
  }
  token(c) {
    const t = this.repo.claim(c.job.chain, c.job.address);
    if (!t || !c.guard()) throw Error("任务已失效");
    return t;
  }
  async capture(ctx) {
    const token = this.token(ctx);
    if (token.chain === '?') {
      const manualBatchId = ctx.job.payload.manualBatchId;
      const r = await this.resolveUnknownChain(token.address, ctx.guard, ctx.signal);
      if (!ctx.guard()) return;
      if (r?.chain && r.chain !== '?' && ctx.guard()) {
        this.repo.diagnostic("chain_resolved", `?:${token.address}`, `${r.chain} via ${r.via}`);
        if (manualBatchId) {
          const detachedPayload = { ...ctx.job.payload };
          delete detachedPayload.manualBatchId;
          delete detachedPayload.manual;
          this.repo.run("UPDATE jobs SET payload=? WHERE id=? AND lease=?", JSON.stringify(detachedPayload), ctx.job.id, ctx.job.lease);
        }
        const expiredOutsideLiveWindow = !manualBatchId && Number(token.last_call || 0) < now() - LIVE_ACTIVITY_WINDOW_SEC;
        this.ingestion.resolveChain(token.address, r.chain, {
          ...(manualBatchId ? { manualBatchId } : {}),
          ...(expiredOutsideLiveWindow ? { skipCapture: true } : {}),
        });
      } else if (r?.ambiguous) {
        this.repo.diagnostic("chain_ambiguous", `?:${token.address}`, `接口命中多个链（${r.chains.join(",")}）；保留原消息，等待确认`);
        throw new WaitError("AVE 返回多个可能链；地址已留待人工核对，不会自动重查", "manual_review");
      } else if (r?.review) {
        const status = r.lookup?.status;
        const reason = status === "ambiguous"
          ? "AVE 网页和 Dex 的结果无法唯一确认链；地址已留待人工核对"
          : status === "token_found"
            ? "AVE 网页找到该代币，但暂时无法读取唯一链；地址已留待人工核对"
          : "AVE 网页和 Dex 都未能确认链；地址已留待人工核对";
        this.repo.diagnostic("chain_unresolved", `?:${token.address}`, reason);
        throw new WaitError(reason, "manual_review");
      } else {
        this.repo.diagnostic("chain_unresolved", `?:${token.address}`, "AVE 网页和 Dex 都未能确认链；地址已留待人工核对");
        throw new WaitError("AVE 网页和 Dex 都未能确认链；地址已留待人工核对", "manual_review");
      }
      return;
    }

    // Database capture only requests the two prices needed for the post-call
    // multiple. Names and logos belong to the independently refreshed overlay.
    try {
      const baselineOutcome = await this.priceAcquisition.baseline(ctx);
      if (baselineOutcome?.again) return baselineOutcome;
    } catch (error) {
      this.repo.diagnostic('baseline', `${token.chain}:${token.address}`, error.message);
      throw error;
    }
    if (!ctx.guard()) return;

    if (ctx.job.payload.stage !== 'history') {
      // Start historical capture after the first completed post-call minute;
      // subsequent shouts never postpone this claim's saved history progress.
      return { again: 60, payload: { stage: 'history', refresh: true } };
    }
    return this.priceAcquisition.history(ctx);
  }
  async quote(provider, chain, address, priority = "background") {
    if (chain === "?") throw new WaitError("等待确认所属链", "chain");
    const key=`${provider}:${chain}:${address}`, cached=this.quoteCache.get(key);
    if(priority==='background' && cached && Date.now()-cached.at<15_000) return cached.value;
    if(this.quoteRequests.has(key)) return this.quoteRequests.get(key);
    const request=(async()=>{
      let m;
      if(provider==='ave') m=await aveTokenInfo(this.bridge,chain,address,priority);
      else if(provider==='dex') m=await Dex.lookup(address,priority,chain);
      else throw new Error(`不支持的行情来源：${provider}`);
      const value=m&&canonicalChain(m.chain)===chain?{...m,provider}:null;
      this.quoteCache.set(key,{value,at:Date.now()});
      return value;
    })();
    this.quoteRequests.set(key,request);
    try{return await request;}finally{if(this.quoteRequests.get(key)===request)this.quoteRequests.delete(key);}
  }
  async confirmFromMarket(token, ctx, priority = "background") {
    const callerGuard=ctx.guard;ctx={...ctx,guard:()=>this.alive()&&callerGuard()};
    if(!ctx.guard())return false;
    const key = `${token.chain}:${token.address}`;
    if (this.metadataActive.has(key)) return false;
    this.metadataActive.add(key);
    try {
    const current = this.repo.get("SELECT metadata FROM tokens WHERE chain=? AND address=?", token.chain, token.address);
    if (!current) return false;
    const metadata = JSON.parse(current.metadata || "{}");
    const sources = { ...(metadata.sources || {}) };
    let hasMarketEvidence = false;
    let added = false;
    let sessionDeferred = false;
    for (const provider of BACKGROUND_METADATA_PROVIDERS) {
      const missingFields = METADATA_FIELDS.filter((field) => missingMetadata(field, metadata[field]));
      if (!missingFields.length && (token.verified || hasMarketEvidence)) break;
      if (!ctx.guard()) return false;
      try {
        const market = await this.quote(provider, token.chain, token.address, priority);
        if (!ctx.guard()) return false;
        if (!market) {
          this.repo.diagnostic("token_verification", key, `${provider}: 未找到匹配代币资料`);
          continue;
        }
        hasMarketEvidence = hasMarketEvidence || !!(positive(market.price) || positive(market.mc));
        for (const field of missingFields) {
          const value = market[field];
          if (value == null || value === "") continue;
          if (field === 'logo' && !usableLogo(value)) continue;
          if (['circulatingSupply', 'liq', 'holders'].includes(field) && !positive(value)) continue;
          if (!missingMetadata(field, metadata[field])) continue;
          metadata[field] = value;
          sources[field] = { provider, at: now() };
          added = true;
        }
        // Let a newly identified DEX token enter live refresh immediately;
        // optional missing metadata can use AVE on the next background pass.
        if (!token.verified && provider === 'dex' && hasMarketEvidence && (metadata.symbol || metadata.name)) break;
      } catch (error) {
        if(!ctx.guard())return false;
        this.repo.diagnostic("token_verification", key, `${provider}: ${error.message}`);
        if (error instanceof AveSessionRequiredError || error?.deferred) { sessionDeferred = true; continue; }
      }
    }
    if(!ctx.guard())return false;
    const canVerify = hasMarketEvidence && !!(metadata.symbol || metadata.name);
    const remaining = METADATA_FIELDS.filter((field) => missingMetadata(field, metadata[field]));
    const lookup = metadata.metadataLookup && typeof metadata.metadataLookup === 'object' ? metadata.metadataLookup : {};
    const attempts = Math.min(METADATA_LOOKUP_MAX_ATTEMPTS, Number(lookup.attempts || 0) + (remaining.length && !sessionDeferred ? 1 : 0));
    const delay = sessionDeferred ? 300 : METADATA_LOOKUP_RETRY_SEC[0];
    metadata.metadataLookup = {
      attempts: remaining.length ? attempts : 0,
      lastAttemptAt: now(),
      nextTryAt: remaining.length ? now() + delay : 0,
      missing: remaining,
    };
    if (!added && !remaining.length && !(canVerify && !token.verified)) return !!token.verified;
    // Other consumers may have saved an avatar while this shared request ran.
    const latest=JSON.parse(this.repo.get('SELECT metadata FROM tokens WHERE chain=? AND address=?',token.chain,token.address)?.metadata||'{}');
    for(const field of METADATA_FIELDS)if(!missingMetadata(field,latest[field])){
      metadata[field]=latest[field];
      if(latest.sources?.[field])sources[field]=latest.sources[field];
    }
    if(latest.logoLookup)metadata.logoLookup=latest.logoLookup;
    metadata.sources = {...latest.sources,...sources};
    this.repo.transaction(() => {
      this.repo.run("UPDATE tokens SET verified=CASE WHEN ? THEN 1 ELSE verified END,metadata=? WHERE chain=? AND address=?", canVerify ? 1 : 0, JSON.stringify(metadata), token.chain, token.address);
    });
    this.repo.project();
    this.invalidateInventory();
    this.repo.diagnostic(canVerify ? "token_verified_without_baseline" : "token_metadata_backfilled", key, `已按字段缺口补充资料（${[...new Set(Object.values(sources).map((s) => s.provider))].join('、')}）${canVerify ? '；喊单前无有效K线，暂不计算倍数' : ''}`);
    this.changed();
    return added || canVerify;
    } finally {
      this.metadataActive.delete(key);
    }
  }
  async priceBars(provider,t,from,to,resolution,seconds,parentSignal){
    if(provider==='ave'){
      try { return await aveCandles(this.bridge,t.chain,t.address,from,to,seconds,'background',parentSignal); }
      catch(error){
        if(error instanceof AveSessionRequiredError || error?.deferred) throw new DeferredError(error.message,error.delay||300);
        throw error;
      }
    }
    throw new Error(`历史价格来源不支持：${provider}`);
  }
  invalidateInventory() {
    this.inventoryDirty = true;
  }
  liveProviderFailureCount(key, provider, token) {
    const id = `${key}|${provider}`;
    const state = this.liveProviderFailures.get(id);
    if (state?.retryAt && Date.now() >= state.retryAt) {
      this.liveProviderFailures.set(id, { ...state, count: 0, retryAt: 0 });
      if (provider === 'ave') this.aveSupplementRetryAt.delete(key);
      return 0;
    }
    return state?.count ?? 0;
  }
  noteLiveProviderFailure(token, provider, message) {
    const key = `${token.chain}:${token.address}`;
    const id = `${key}|${provider}`;
    // A transport outage says nothing about whether the token has a price.
    // Never consume the permanent no-data budget for a temporary network error.
    if (isTransientMarketError(message) || /ERR_(?:CONNECTION|INTERNET|NETWORK|NAME|TIMED|PROXY|TUNNEL|ABORTED)/i.test(String(message))) {
      this.repo.diagnostic('realtime', key, `${provider}: ${message}（临时网络异常，延时重试）`);
      return false;
    }
    const prior = this.liveProviderFailures.get(id);
    const sameCall = !!prior;
    const count = (sameCall ? prior.count : 0) + 1;
    const parked = count >= LIVE_PROVIDER_FAILURE_LIMIT;
    const round = (sameCall ? Number(prior.round || 0) : 0) + (parked ? 1 : 0);
    const retryAt = parked ? Date.now() + [300_000, 1800_000, 7200_000][Math.min(round - 1, 2)] : 0;
    this.liveProviderFailures.set(id, { version: token.version, lastCall: token.lastCall, count, round, retryAt });
    if (parked && provider === 'ave') this.aveSupplementRetryAt.set(key, retryAt);
    this.repo.diagnostic('realtime', key, `${provider}: ${message}（连续失败 ${count}/${LIVE_PROVIDER_FAILURE_LIMIT}${parked ? '，冷却后自动复查' : ''}）`);
    return parked;
  }
  noteLiveProviderSuccess(token, provider) {
    this.liveProviderFailures.delete(`${token.chain}:${token.address}|${provider}`);
  }
  setVisible(keys) {
    this.visible = new Set(keys.filter(key => typeof key === 'string').slice(0, 50));
    this.visibleDue ??= new Map();
    for (const key of this.visibleDue.keys()) if (!this.visible.has(key)) this.visibleDue.delete(key);
    for (const [key, retryAt] of this.visibleMetadataRetryAt) if (retryAt < Date.now() - 30 * 60_000) this.visibleMetadataRetryAt.delete(key);
    void this.refreshFastMetadata();
    this.scheduleVisible();
  }
  retryVisibleMetadataLater(key, delayMs) {
    this.visibleMetadataRetryAt.delete(key);
    this.visibleMetadataRetryAt.set(key, Date.now() + delayMs);
    while (this.visibleMetadataRetryAt.size > 512) this.visibleMetadataRetryAt.delete(this.visibleMetadataRetryAt.keys().next().value);
  }
  persistFastMetadata(entries, results) {
    if(!this.alive())return;
    const updates = [];
    for (const entry of entries) {
      const found = results.get(entry.address);
      if (!found) {
        this.retryVisibleMetadataLater(entry.key, 30_000);
        continue;
      }
      const current = this.repo.get(
        `SELECT t.chain,t.metadata FROM tokens t JOIN claims c USING(chain,address)
         WHERE t.address=? AND t.blocked=0 AND c.active=1
         ORDER BY CASE WHEN t.chain=? THEN 0 ELSE 1 END LIMIT 1`,
        entry.address, entry.chain,
      );
      if (!current) continue;
      let metadata;
      try { metadata = JSON.parse(current.metadata || '{}'); } catch { metadata = {}; }
      metadata.dexDisplayLookup = { chain: canonicalChain(found.chain) || entry.chain, at: now() };
      const sources = { ...(metadata.sources || {}) };
      let changed = false;
      for (const field of ['symbol', 'name', 'logo']) {
        const value = found[field];
        if (value == null || value === '' || !missingMetadata(field, metadata[field])) continue;
        if (field === 'logo' && !usableLogo(value)) continue;
        metadata[field] = value;
        sources[field] = { provider: 'dex', at: now() };
        changed = true;
      }
      if (changed) {
        metadata.sources = { ...(metadata.sources || {}), ...sources };
        updates.push({ ...entry, chain: current.chain, metadata: JSON.stringify(metadata) });
      }
      const stillMissing = ['symbol', 'name', 'logo'].some((field) => missingMetadata(field, metadata[field]));
      if (stillMissing) this.retryVisibleMetadataLater(entry.key, 30_000);
      else this.visibleMetadataRetryAt.delete(entry.key);
    }
    if (!updates.length) return;
    this.repo.transaction(() => {
      for (const update of updates) this.repo.run(
        'UPDATE tokens SET metadata=? WHERE chain=? AND address=?',
        update.metadata, update.chain, update.address,
      );
    });
    this.repo.project();
    this.invalidateInventory();
    this.changed();
  }
  async refreshFastMetadata(keys = [...this.visible], { includeUnknown = false, priority = 'live' } = {}) {
    if (this.stopped) return;
    const byChain = new Map();
    const unknownChain = [];
    const muted = new Set(this.repo.setting('monitorMutes', []));
    for (const key of keys.slice(0, 50)) {
      const separator = key.indexOf(':');
      if (separator <= 0 || muted.has(key) || this.visibleMetadataActive.has(key) || (this.visibleMetadataRetryAt.get(key) || 0) > Date.now()) continue;
      const chain = canonicalChain(key.slice(0, separator));
      const address = key.slice(separator + 1);
      if (!chain || !address) continue;
      if (chain === '?' && !includeUnknown && !this.visible.has(key)) continue;
      if ([...this.visibleMetadataActive].some((activeKey) => activeKey.slice(activeKey.indexOf(':') + 1) === address)) continue;
      const row = this.repo.get(
        `SELECT t.metadata FROM tokens t WHERE t.chain=? AND t.address=? AND t.blocked=0
         AND EXISTS(SELECT 1 FROM claims c WHERE c.chain=t.chain AND c.address=t.address AND c.active=1)`,
        chain, address,
      );
      if (!row) continue;
      let metadata;
      try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = {}; }
      if (metadata.manualDisposition === 'wallet' || ['wallet', 'unlisted'].includes(metadata.autoDisposition)) continue;
      if (!['symbol', 'name', 'logo'].some((field) => missingMetadata(field, metadata[field]))) continue;
      if (chain === '?') {
        unknownChain.push({ key, chain, address });
        continue;
      }
      const group = byChain.get(chain) || [];
      group.push({ key, chain, address });
      byChain.set(chain, group);
    }
    if (!byChain.size && !unknownChain.length) return;
    await Promise.all([
      ...[...byChain].map(async ([chain, entries]) => {
      for (const entry of entries) this.visibleMetadataActive.add(entry.key);
      try {
        const result = await Dex.batchMetadata(Chain.toDex(chain), entries.map((entry) => entry.address), priority);
        this.persistFastMetadata(entries, result);
      } catch {
        for (const entry of entries) this.retryVisibleMetadataLater(entry.key, 15_000);
      } finally {
        for (const entry of entries) this.visibleMetadataActive.delete(entry.key);
      }
      }),
      ...unknownChain.map(async (entry) => {
        this.visibleMetadataActive.add(entry.key);
        try {
          const found = await Dex.lookupMetadata(entry.address, priority);
          this.persistFastMetadata([entry], new Map(found ? [[entry.address, found]] : []));
        } catch {
          this.retryVisibleMetadataLater(entry.key, 15_000);
        } finally {
          this.visibleMetadataActive.delete(entry.key);
        }
      }),
    ]);
  }
  scheduleVisible() {
    clearTimeout(this.visibleTimer);
    if (this.stopped) return;
    this.visibleDue ??= new Map();
    const ts = Date.now();
    let next = Infinity;
    const dueByChain = new Map();
    for (const key of this.visible) {
      const token = this.inventory.get(key);
      if (!token || token.chain === '?' || token.lastCall < now() - LIVE_ACTIVITY_WINDOW_SEC || this.active.has(key)) continue;
      if (this.liveProviderFailureCount(key, 'ave', token) >= LIVE_PROVIDER_FAILURE_LIMIT &&
          this.liveProviderFailureCount(key, 'dex', token) >= LIVE_PROVIDER_FAILURE_LIMIT) continue;
      const recent = this.live.get(key);
      const freshUntil = Number(recent?.receivedAt || 0) * 1000 + LIVE_OVERLAY_DEX_REFRESH_MS;
      if (recent?.version === token.version && freshUntil > ts) {
        this.visibleDue.set(key, freshUntil);
        next = Math.min(next, freshUntil);
        continue;
      }
      const due = this.visibleDue.get(key) || 0;
      if (due > ts) { next = Math.min(next, due); continue; }
      const generation = (this.generation.get(key)?.value ?? 0) + 1;
      this.generation.set(key, { value: generation, retryAt: 0 });
      this.active.set(key, generation);
      this.visibleDue.set(key, ts + LIVE_OVERLAY_DEX_REFRESH_MS);
      const items=dueByChain.get(token.chain)||[];items.push({token,key,generation});dueByChain.set(token.chain,items);
    }
    for(const [chain,items] of dueByChain)for(let i=0;i<items.length;i+=30)void this.refreshDexBatch(chain,items.slice(i,i+30));
    if (Number.isFinite(next)) this.visibleTimer = setTimeout(() => this.scheduleVisible(), Math.max(10, next - Date.now()));
  }
  recoverUnverifiedCandidatesOnce(marker = 'unverifiedAddressRecheckNoAveDataApiV1') {
    if (this.repo.setting(marker, null)) return 0;
    const ts = now();
    const rows = this.repo.all(`
      SELECT c.chain,c.address,c.version FROM claims c
      JOIN tokens t ON t.chain=c.chain AND t.address=c.address
      WHERE c.active=1 AND t.verified=0 AND t.blocked=0 AND t.last_call>=?
    `, ts - LIVE_ACTIVITY_WINDOW_SEC);
    let resumed = 0;
    for (const token of rows) {
      const job = this.repo.get(
        "SELECT id,state FROM jobs WHERE lane='capture' AND chain=? AND address=? AND claim_version=? ORDER BY id DESC LIMIT 1",
        token.chain, token.address, token.version,
      );
      if (job && ['QUEUED', 'BACKOFF', 'RUNNING'].includes(job.state)) continue;
      if (job) {
        this.repo.run(
          "UPDATE jobs SET state='QUEUED',attempts=0,due=?,wait=NULL,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=?",
          ts, ts, job.id,
        );
      } else {
        this.repo.enqueue('capture', token.chain, token.address, token.version, {}, 1, ts);
      }
      resumed++;
    }
    this.repo.set(marker, { at: ts, count: resumed });
    if (resumed) this.repo.diagnostic('token_probe_recovery', null, `重新排入 ${resumed} 个近期未确认地址；未知链按 AVE 网页→Dex 核对，仍无法确认则留待人工核对`);
    return resumed;
  }
  recoverLegacyAvePageFailuresOnce(marker = 'unknownChainFallbackResumeV2') {
    if (this.repo.setting(marker, null)) return 0;
    const ts = now();
    const rows = this.repo.all(`
      SELECT t.address,t.metadata,j.id job_id
      FROM tokens t JOIN claims c USING(chain,address)
      JOIN jobs j ON j.lane='capture' AND j.chain=t.chain AND j.address=t.address AND j.claim_version=c.version
      WHERE c.active=1 AND t.chain='?' AND c.active=1 AND t.blocked=0
        AND json_extract(t.metadata,'$.chainResolutionFallback.avePage.error') LIKE '%未知桌面请求%'
        AND j.state='PARKED' AND j.wait='manual_review'
    `);
    let resumed = 0;
    for (const row of rows) {
      let metadata = {};
      try { metadata = JSON.parse(row.metadata || '{}'); } catch {}
      const fallback = metadata.chainResolutionFallback || {};
      metadata.chainResolutionFallback = { ...fallback, complete: false, attempts: 0, retryAt: ts, recoveredFromOldDesktopPackage: true };
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain='?' AND address=?", JSON.stringify(metadata), row.address);
      resumed += this.repo.run(
        "UPDATE jobs SET state='QUEUED',attempts=0,due=?,wait=NULL,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND state='PARKED' AND wait='manual_review'",
        ts, ts, row.job_id,
      ).changes;
    }
    this.repo.set(marker, { at: ts, count: resumed });
    if (resumed) this.repo.diagnostic('token_probe_recovery', null, `恢复 ${resumed} 条旧桌面包未执行 AVE 网页查询的定链任务；保留已有链检索结果`);
    return resumed;
  }
  recoverLegacyAveAddressSearchOnce(marker = 'aveAddressSearchParserV7') {
    if (this.repo.setting(marker, null)) return 0;
    const ts = now();
    const rows = this.repo.all(`
      SELECT c.address,t.metadata
      FROM claims c JOIN tokens t USING(chain,address)
      WHERE c.active=1 AND c.chain='?' AND t.blocked=0 AND t.verified=0
        AND COALESCE(json_extract(t.metadata,'$.autoDisposition'),'') NOT IN ('wallet','unlisted')
        AND COALESCE(CAST(json_extract(t.metadata,'$.chainResolutionFallback.addressSearchVersion') AS INTEGER),0)<7
        AND COALESCE(json_extract(t.metadata,'$.aveChainLookup.status'),'')<>'found'
      ORDER BY c.at DESC LIMIT 100
    `);
    for (const row of rows) {
      let metadata = {};
      try { metadata = JSON.parse(row.metadata || '{}'); } catch {}
      const fallback = metadata.chainResolutionFallback || {};
      metadata.chainResolutionFallback = {
        ...fallback,
        addressSearchVersion: 7,
        complete: false,
        attempts: 0,
        retryAt: ts,
        parserRecheckedAt: ts,
      };
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain='?' AND address=?", JSON.stringify(metadata), row.address);
    }
    this.repo.set(marker, { at: ts, count: rows.length });
    if (rows.length) this.repo.diagnostic('token_probe_recovery', null, `AVE 网页地址匹配修复后，重新排入 ${rows.length} 个未确认地址`);
    return rows.length;
  }
  resumeDueChainFallbacks() {
    const ts = now();
    const rows = this.repo.all(`
      SELECT c.address,c.version,t.metadata,j.id job_id,j.state job_state,j.wait
      FROM claims c JOIN tokens t ON t.chain=c.chain AND t.address=c.address
      JOIN jobs j ON j.lane='capture' AND j.chain=c.chain AND j.address=c.address AND j.claim_version=c.version
      WHERE c.active=1 AND c.chain='?' AND t.blocked=0 AND j.state='PARKED' AND j.wait='manual_review'
        AND (t.last_call>=? OR json_extract(t.metadata,'$.chainResolutionFallback.parserRecheckedAt') IS NOT NULL)
      ORDER BY c.at DESC LIMIT 100
    `, ts - LIVE_ACTIVITY_WINDOW_SEC);
    let resumed = 0;
    for (const row of rows) {
      let metadata = {};
      try { metadata = JSON.parse(row.metadata || '{}'); } catch {}
      const fallback = metadata.chainResolutionFallback || {};
      if (!metadata.aveChainLookup || fallback.complete || Number(fallback.retryAt || 0) > ts) continue;
      const changed = this.repo.run(
        "UPDATE jobs SET state='QUEUED',attempts=0,due=?,wait=NULL,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND state='PARKED' AND wait='manual_review'",
        ts, ts, row.job_id,
      ).changes;
      resumed += changed;
    }
    if (resumed) this.repo.diagnostic('token_probe_recovery', null, `恢复 ${resumed} 个近期未完成的 AVE 网页/Dex 定链任务`);
    return resumed;
  }
  resumePendingChainFallbacksOnce() {
    this.recoverLegacyAvePageFailuresOnce();
    this.recoverLegacyAveAddressSearchOnce();
    this.recoverExhaustedTransientFallbacksOnce();
    this.recoverRecentCompletedNoMatchesOnce();
    return this.resumeDueChainFallbacks();
  }
  recoverRecentCompletedNoMatchesOnce(marker = 'completedChainNoMatchRecheckV1') {
    if (this.repo.setting(marker, null)) return 0;
    const ts = now();
    const rows = this.repo.all(`
      SELECT c.address,t.metadata,j.id job_id
      FROM claims c JOIN tokens t ON t.chain=c.chain AND t.address=c.address
      JOIN jobs j ON j.lane='capture' AND j.chain=c.chain AND j.address=c.address AND j.claim_version=c.version
      WHERE c.active=1 AND c.chain='?' AND t.blocked=0 AND t.verified=0
        AND c.at>=? AND j.state='PARKED' AND j.wait IN('manual_review','manual_unlisted')
        AND COALESCE(CAST(json_extract(t.metadata,'$.chainResolutionFallback.attempts') AS INTEGER),0)<=1
        AND json_extract(t.metadata,'$.chainResolutionFallback.complete')=1
        AND json_extract(t.metadata,'$.chainResolutionFallback.avePage.status')='no_match'
        AND json_extract(t.metadata,'$.chainResolutionFallback.dex.status')='no_match'
        AND COALESCE(json_extract(t.metadata,'$.manualDisposition'),'')<>'wallet'
        AND COALESCE(json_extract(t.metadata,'$.autoDisposition'),'')<>'wallet'
      ORDER BY c.at DESC LIMIT 100
    `, ts - LIVE_ACTIVITY_WINDOW_SEC);
    let resumed = 0;
    for (const row of rows) {
      let metadata = {};
      try { metadata = JSON.parse(row.metadata || '{}'); } catch {}
      const fallback = metadata.chainResolutionFallback || {};
      metadata.chainResolutionFallback = {
        ...fallback,
        complete: false,
        attempts: Math.max(1, Number(fallback.attempts || 0)),
        retryAt: ts,
        recheckedAfterNoMatch: true,
      };
      const changes = this.repo.transaction(() => {
        this.repo.run("UPDATE tokens SET metadata=? WHERE chain='?' AND address=?", JSON.stringify(metadata), row.address);
        return this.repo.run(
          "UPDATE jobs SET state='QUEUED',attempts=0,due=?,wait=NULL,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND state='PARKED' AND wait IN('manual_review','manual_unlisted')",
          ts, ts, row.job_id,
        ).changes;
      });
      resumed += changes;
    }
    this.repo.set(marker, { at: ts, count: resumed });
    if (resumed) {
      this.repo.diagnostic('token_probe_recovery', null, `将 ${resumed} 个近期被 AVE/Dex 漏过的未确认地址重新核对一次`);
      this.changed();
    }
    return resumed;
  }
  recoverExhaustedTransientFallbacksOnce(marker = 'transientChainFallbackRetryV1') {
    if (this.repo.setting(marker, null)) return 0;
    const ts = now();
    const rows = this.repo.all(`
      SELECT c.address,t.metadata
      FROM claims c JOIN tokens t ON t.chain=c.chain AND t.address=c.address
      WHERE c.active=1 AND c.chain='?' AND t.blocked=0 AND t.verified=0
        AND json_extract(t.metadata,'$.chainResolutionFallback.exhausted')=1
        AND (json_extract(t.metadata,'$.chainResolutionFallback.avePage.error') IS NOT NULL
          OR json_extract(t.metadata,'$.chainResolutionFallback.dex.error') IS NOT NULL)
    `);
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata || '{}');
      const fallback = metadata.chainResolutionFallback || {};
      delete fallback.exhausted;
      metadata.chainResolutionFallback = { ...fallback, complete: false, retryAt: ts + 6 * 60 * 60 };
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain='?' AND address=?", JSON.stringify(metadata), row.address);
    }
    this.repo.set(marker, { at: ts, count: rows.length });
    if (rows.length) this.repo.diagnostic('token_probe_recovery', null, `将 ${rows.length} 个旧版因 AVE/Dex 临时错误停止的地址恢复到低频自动重试`);
    return rows.length;
  }
  archiveCompletedNoMatchCandidatesOnce(marker = 'unknownAddressNoMatchArchiveV1') {
    if (this.repo.setting(marker, null)) return 0;
    const rows = this.repo.all(`
      SELECT DISTINCT t.address
      FROM tokens t JOIN claims c ON c.chain=t.chain AND c.address=t.address
      WHERE t.chain='?' AND c.active=1 AND t.blocked=0 AND t.verified=0
        AND COALESCE(json_extract(t.metadata,'$.manualDisposition'),'')<>'wallet'
        AND COALESCE(json_extract(t.metadata,'$.autoDisposition'),'') NOT IN ('wallet','unlisted')
        AND json_extract(t.metadata,'$.autoWalletAudit.status')='unknown'
        AND json_extract(t.metadata,'$.autoWalletAudit.reason')='所查网络都没有该地址的发起交易记录，不能仅凭无合约代码判定为钱包'
        AND json_extract(t.metadata,'$.chainResolutionFallback.complete')=1
        AND json_extract(t.metadata,'$.chainResolutionFallback.avePage.status')='no_match'
        AND json_extract(t.metadata,'$.chainResolutionFallback.dex.status')='no_match'
    `);
    let archived = 0;
    for (const row of rows) if (this.ingestion.archiveUnknownCandidate(row.address)) archived++;
    this.repo.set(marker, { at: now(), count: archived });
    if (archived) this.repo.diagnostic('token_auto_unlisted', null, `将 ${archived} 个 AVE 与 Dex 均无命中、且链上无钱包活动证据的地址移入可恢复归档`);
    return archived;
  }
  async auditNextUnknownWallet(preferredAddresses = []) {
    if (!this.alive() || this.walletAuditBusy) return;
    const ts = now();
    const deadAddress = "0x000000000000000000000000000000000000dead";
    if (this.repo.get(`
      SELECT 1 FROM claims c JOIN tokens t USING(chain,address)
      WHERE c.chain='?' AND c.address=? AND c.active=1 AND t.blocked=0 AND t.verified=0 LIMIT 1
    `, deadAddress)) {
      this.ingestion.ignoreUnknownChain(deadAddress, "已识别为 EVM 销毁地址，不作为代币处理");
      return;
    }
    const staleChecks = this.repo.all(`
      SELECT chain,address,metadata FROM tokens
      WHERE chain IN('?','sol','eth','bsc','base','monad','robinhood','arc') AND blocked=0 AND verified=0
        AND json_extract(metadata,'$.autoWalletAudit.status')='checking'
        AND CAST(COALESCE(json_extract(metadata,'$.autoWalletAudit.checkedAt'),0) AS INTEGER)<=?
    `, ts - 120);
    for (const row of staleChecks) {
      const metadata = JSON.parse(row.metadata || "{}");
      delete metadata.autoWalletAudit;
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain=? AND address=?", JSON.stringify(metadata), row.chain, row.address);
    }
    const legacyAudits = this.repo.all(`
      SELECT chain,address,metadata FROM tokens
      WHERE chain IN('?','sol','eth','bsc','base','monad','robinhood','arc') AND blocked=0 AND verified=0
        AND json_extract(metadata,'$.autoWalletAudit.status') IN('unknown','contract')
        AND CAST(COALESCE(json_extract(metadata,'$.autoWalletAudit.engineVersion'),0) AS INTEGER)<2
    `);
    for (const row of legacyAudits) {
      const metadata = JSON.parse(row.metadata || "{}");
      delete metadata.autoWalletAudit;
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain=? AND address=?", JSON.stringify(metadata), row.chain, row.address);
    }
    if (staleChecks.length || legacyAudits.length) this.changed();
    const preferred = [...new Set([
      ...preferredAddresses.map((address) => String(address).toLowerCase()),
      ...this.walletAuditPriority,
    ])].slice(0, 100);
    const priorityOrder = preferred.length ? `CASE WHEN lower(t.address) IN(${preferred.map(() => '?').join(',')}) THEN 0 ELSE 1 END,` : '';
    const token = this.repo.get(`
      SELECT t.chain,t.address,t.metadata
      FROM tokens t JOIN claims c ON c.chain=t.chain AND c.address=t.address
      WHERE t.chain IN('?','sol','eth','bsc','base','monad','robinhood','arc') AND t.blocked=0 AND t.verified=0 AND c.active=1
        AND t.last_call>=${ts - RECENT_WINDOW_SEC}
        AND COALESCE(json_extract(t.metadata,'$.manualDisposition'),'')<>'wallet'
        AND COALESCE(json_extract(t.metadata,'$.autoDisposition'),'') NOT IN ('wallet','unlisted')
        AND COALESCE(json_extract(t.metadata,'$.autoWalletAudit.status'),'')<>'contract'
        AND COALESCE(CAST(json_extract(t.metadata,'$.autoWalletAudit.retryAt') AS INTEGER),0)<=?
      ORDER BY ${priorityOrder} c.at ASC,t.address ASC LIMIT 1
    `, ts, ...preferred);
    if (!token) return;
    const priorityKey = token.address.toLowerCase();
    const wasPriority = this.walletAuditPriority.has(priorityKey);
    this.walletAuditBusy = true;
    try {
      const address = token.address;
      if (token.chain === "sol" && /^0x[\da-f]{40}$/i.test(address)) {
        const verifiedEvm = this.repo.get(`
          SELECT chain FROM tokens
          WHERE address=? AND chain NOT IN('sol','?') AND blocked=0 AND verified=1
          ORDER BY chain LIMIT 1
        `, address);
        if (verifiedEvm) {
          this.walletAuditPriority.delete(priorityKey);
          this.ingestion.resolveChain(address, verifiedEvm.chain, { sourceChain: "sol" });
          this.repo.diagnostic("chain_resolved", `sol:${address}`, `${verifiedEvm.chain} via verified EVM token identity`);
          return;
        }
      }
      const checkMetadata = JSON.parse(token.metadata || "{}");
      const priorRpcRetries = Math.max(0, Number(checkMetadata.autoWalletAudit?.rpcRetryCount || 0));
      checkMetadata.autoWalletAudit = { status: "checking", checkedAt: ts, ...(priorRpcRetries ? { rpcRetryCount: priorRpcRetries } : {}) };
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain=? AND address=?", JSON.stringify(checkMetadata), token.chain, address);
      this.changed();
      const auditPromise = /^0x[\da-f]{40}$/i.test(address)
        ? auditEvmWalletAddress(address)
        : isSolanaPublicKey(address)
          ? auditSolanaWalletAddress(address)
          : Promise.resolve({ kind: "unknown", reason: "地址格式不属于支持的 EVM 或 Solana 地址" });
      let timeout;
      let result = await Promise.race([
        auditPromise,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("自动复核超时，地址保留待确认")), 30_000); }),
      ]).finally(() => clearTimeout(timeout));
      if(!this.alive())return;
      const checkedAt = now();
      if (result.kind === "wallet") {
        this.walletAuditPriority.delete(priorityKey);
        this.ingestion.markUnknownWallet(address, { automatic: true, evidence: result });
        this.repo.diagnostic("token_auto_wallet_audit", `${token.chain}:${address}`, `自动复核为钱包：${JSON.stringify(result)}`);
        return;
      }
      if (token.chain === "sol") {
        const mintCheck = await checkSolanaMint(address);
        if(!this.alive())return;
        if (mintCheck.kind === "not-mint") {
          this.walletAuditPriority.delete(priorityKey);
          this.ingestion.ignoreUnknownChain(
            address,
            "Solana 复核确认这不是 SPL Token Mint；保留原始消息，不作为可计价代币处理（" + mintCheck.reason + "）",
            "sol",
          );
          return;
        }
        if (mintCheck.kind === "mint") {
          result = { kind: "contract", reason: "已确认是 SPL Token Mint；继续等待可用行情基准" };
        } else {
          result = { kind: "unknown", reason: mintCheck.reason, checkedNetworks: [] };
        }
      }
      if (result.kind === "contract" && Array.isArray(result.networks)) {
        const checks = await Promise.all(result.networks.map(async (chain) => ({ chain, verdict: await Erc20.checkChain(address, chain) })));
        if(!this.alive())return;
        const tokenChains = checks.filter((item) => item.verdict === "erc20").map((item) => item.chain);
        if (tokenChains.length === 1) {
          this.walletAuditPriority.delete(priorityKey);
          this.ingestion.resolveChain(address, tokenChains[0], { sourceChain: token.chain });
          this.repo.diagnostic("chain_resolved", `?:${address}`, `${tokenChains[0]} via direct EVM token-contract check`);
          return;
        }
        if (tokenChains.length > 1) result = { ...result, reason: `发现多个链上的代币合约（${tokenChains.join("、")}），保留待核对` };
        else if (checks.length && checks.every((item) => item.verdict === "non-erc20")) {
          this.walletAuditPriority.delete(priorityKey);
          this.ingestion.ignoreUnknownChain(
            address,
            "在 " + result.networks.join("、") + " 检测到合约代码，但均不符合 ERC-20 代币接口；保留原始消息，不作为可计价代币处理",
            token.chain,
          );
          return;
        } else if (checks.some((item) => item.verdict === "unknown")) {
          result = { kind: "unknown", reason: "ERC-20 接口复核遇到 RPC 不可用，稍后重试", checkedNetworks: result.checkedNetworks };
        }
      }
      const current = this.repo.get("SELECT metadata FROM tokens WHERE chain=? AND address=? AND blocked=0", token.chain, address);
      if (!current) {
        this.walletAuditPriority.delete(priorityKey);
        return;
      }
      const metadata = JSON.parse(current.metadata || "{}");
      const rpcUnavailable = /RPC|timeout|timed out|超时|temporarily unavailable|socket hang up|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(result.reason || "");
      const nextRpcRetries = result.kind === "unknown" && rpcUnavailable ? priorRpcRetries + 1 : 0;
      const retryDelaySec = result.kind === "unknown"
        ? rpcUnavailable && priorRpcRetries === 0 ? 60 : rpcUnavailable ? 6 * 60 * 60 : 24 * 60 * 60
        : 0;
      metadata.autoWalletAudit = {
        status: result.kind,
        engineVersion: 2,
        reason: result.reason,
        checkedAt,
        ...(Array.isArray(result.checkedNetworks) ? { checkedNetworks: result.checkedNetworks } : {}),
        ...(result.kind === "unknown" ? { retryAt: checkedAt + retryDelaySec, ...(rpcUnavailable ? { rpcRetryCount: nextRpcRetries } : {}) } : {}),
        ...(result.kind === "contract" ? { evidence: result } : {}),
      };
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain=? AND address=?", JSON.stringify(metadata), token.chain, address);
      this.repo.diagnostic("token_auto_wallet_audit", `${token.chain}:${address}`, `自动复核未移出：${result.reason || result.kind}`);
      if (!(wasPriority && result.kind === "unknown" && rpcUnavailable && priorRpcRetries === 0)) this.walletAuditPriority.delete(priorityKey);
      if (token.chain === "?" && result.kind === "unknown") this.ingestion.archiveUnknownCandidate(address);
      this.changed();
    } catch (error) {
      if(!this.alive())return;
      const reason = String(error?.message ?? error).slice(0, 300);
      this.repo.diagnostic("token_auto_wallet_audit", `${token.chain}:${token.address}`, `自动复核异常，保留待核对：${reason}`);
      const current = this.repo.get("SELECT metadata FROM tokens WHERE chain=? AND address=? AND blocked=0", token.chain, token.address);
      if (!current) this.walletAuditPriority.delete(priorityKey);
      if (current) {
        const metadata = JSON.parse(current.metadata || "{}");
        const priorRpcRetries = Math.max(0, Number(metadata.autoWalletAudit?.rpcRetryCount || 0));
        const rpcUnavailable = /RPC|timeout|timed out|超时|temporarily unavailable|socket hang up|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(reason);
        const nextRpcRetries = rpcUnavailable ? priorRpcRetries + 1 : priorRpcRetries;
        const retryDelaySec = rpcUnavailable && priorRpcRetries === 0 ? 60 : 6 * 60 * 60;
        metadata.autoWalletAudit = {
          status: "unknown", engineVersion: 2, reason, checkedAt: ts,
          retryAt: ts + retryDelaySec,
          ...(rpcUnavailable ? { rpcRetryCount: nextRpcRetries } : {}),
        };
        this.repo.run("UPDATE tokens SET metadata=? WHERE chain=? AND address=?", JSON.stringify(metadata), token.chain, token.address);
        if (!(wasPriority && rpcUnavailable && priorRpcRetries === 0)) this.walletAuditPriority.delete(priorityKey);
        this.changed();
      }
    } finally {
      this.walletAuditBusy = false;
    }
  }
  start() {
    this.stopped = false;
    const requeuedApiWaits = this.repo.run(`
      UPDATE jobs SET state='QUEUED',wait=NULL,due=?,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=?
      WHERE lane='capture' AND chain='?' AND state='PARKED' AND wait='ave_api_key'
        AND EXISTS (SELECT 1 FROM claims c WHERE c.chain=jobs.chain AND c.address=jobs.address AND c.version=jobs.claim_version AND c.active=1)
    `, now(), now()).changes;
    if (requeuedApiWaits) this.repo.diagnostic('token_probe_recovery', null, `恢复 ${requeuedApiWaits} 个旧 API Key 等待任务；改用 AVE 网页→Dex 核对`);
    this.recoverUnverifiedCandidatesOnce();
    this.resumePendingChainFallbacksOnce();
    this.archiveCompletedNoMatchCandidatesOnce();
    this.inventoryDirty = true;
    this.liveTimer = setInterval(() => this.refresh(), 1000);
    clearInterval(this.providerMetricsTimer);
    this.providerMetricsTimer = setInterval(() => this.flushProviderMetrics(), 10 * 60 * 1000);
    this.chainFallbackTimer = setInterval(() => this.resumeDueChainFallbacks(), 60 * 1000);
    void this.auditNextUnknownWallet();
    clearInterval(this.walletAuditTimer);
    this.walletAuditTimer = setInterval(() => void this.auditNextUnknownWallet(), 3 * 1000);
    this.refresh();
  }
  flushProviderMetrics() {
    if(this.repo.db?.open===false)return;
    const metrics = takeProviderRequestMetrics();
    this.repo.diagnostic('source_metrics', null, JSON.stringify({ windowMinutes: 10, sources: metrics }));
  }
  refresh() {
    if (this.stopped) return;
    if(!this.lastManualResumeAt||now()-this.lastManualResumeAt>=15){this.lastManualResumeAt=now();resumeAutomaticAfterManual(this.repo);}
    this.schedulePeakRefreshes();
    this.scheduleNoDataRetries();
    if (this.inventoryDirty || now() - this.lastInventoryReconcile >= 60) {
      const rows = this.repo.view({ since: now() - LIVE_ACTIVITY_WINDOW_SEC });
      for(const row of rows)if((row.quote?.fieldSources?.price?.provider||row.quote?.provider)==='dex'&&row.quote.poolId)
        Dex.restorePairSelection(row.chain,row.address,row.quote.poolId);
      this.inventory = new Map(rows.map((t) => [`${t.chain}:${t.address}`, t]));
      this.inventoryDirty = false;
      this.lastInventoryReconcile = now();
    }
    if (Date.now() - this.lastEphemeralStateCleanup >= 60_000) this.cleanupEphemeralState();
    const highCutoff = now() - LIVE_HIGH_TTL_SEC;
    for (const [key, high] of this.liveHighs) if (high.receivedAt < highCutoff) this.liveHighs.delete(key);
    while (this.liveHighs.size > LIVE_HIGH_LIMIT) this.liveHighs.delete(this.liveHighs.keys().next().value);
    const allRows = [...this.inventory.values()];
    const rows = allRows.filter((t) => t.lastCall >= now() - LIVE_ACTIVITY_WINDOW_SEC);
    const activeKeys = new Set(rows.map((t) => `${t.chain}:${t.address}`));
    for (const key of this.generation.keys())
      if (!activeKeys.has(key)) this.generation.delete(key);
    for (const key of this.live.keys()) if (!activeKeys.has(key)) this.live.delete(key);
    const eligible = rows.sort(
      (a, b) =>
        Number(this.visible.has(`${b.chain}:${b.address}`)) -
          Number(this.visible.has(`${a.chain}:${a.address}`)) ||
        b.lastCall - a.lastCall,
    );
    this.scheduleVisible();
    // Live rows get first use of the serial metadata lanes. Historical rows
    // are scanned separately in small, low-frequency pages below.
    const logoCandidates = allRows
      .filter((t) => !usableLogo(t.logo) || (Array.isArray(t.logoLookup?.failedUrls) && t.logoLookup.failedUrls.includes(t.logo.trim())))
      .sort(
        (a, b) =>
          Number(this.visible.has(`${b.chain}:${b.address}`)) -
            Number(this.visible.has(`${a.chain}:${a.address}`)) ||
          b.lastCall - a.lastCall,
      );
    this.refreshMissingLogos(logoCandidates);
    this.refreshMissingMetadata(allRows);
    this.refreshHistoricalMetadata();
    const dueQuotes = [];
    for (const t of eligible) {
      if (this.active.size + dueQuotes.length >= LIVE_QUOTE_MAX_ACTIVE) break;
      const key = `${t.chain}:${t.address}`;
      if (this.visible.has(key) || this.active.has(key)) continue;
      if (this.liveProviderFailureCount(key, 'ave', t) >= LIVE_PROVIDER_FAILURE_LIMIT &&
          this.liveProviderFailureCount(key, 'dex', t) >= LIVE_PROVIDER_FAILURE_LIMIT) continue;
      const q = this.live.get(key);
      const due = 15;
      if (q && LIVE_QUOTE_PROVIDERS.includes(q.provider) && q.version === t.version && now() - q.receivedAt < due) continue;
      const gate = this.generation.get(key);
      if (gate?.retryAt > Date.now()) continue;
      const generation = (gate?.value ?? 0) + 1;
      this.generation.set(key, {
        value: generation,
        retryAt: Date.now() + 3000,
      });
      this.active.set(key, generation);
      dueQuotes.push({ token: t, generation, key });
    }
    const batches = new Map();
    for (const item of dueQuotes) {
      const group = batches.get(item.token.chain) ?? [];
      group.push(item);
      batches.set(item.token.chain, group);
    }
    for (const [chain, items] of batches) {
      for (let offset = 0; offset < items.length; offset += 30) {
        void this.refreshDexBatch(chain, items.slice(offset, offset + 30));
      }
    }
  }
  cleanupEphemeralState() {
    this.lastEphemeralStateCleanup = Date.now();
    const active = new Set(this.inventory.keys());
    for(const [key,cached] of this.quoteCache) if(Date.now()-cached.at>15_000)this.quoteCache.delete(key);
    for (const key of this.live.keys()) if (!active.has(key)) this.live.delete(key);
    for (const key of this.quotePersistedAt.keys()) if (!active.has(key.slice(0, key.lastIndexOf('|')))) this.quotePersistedAt.delete(key);
    for (const key of this.aveSupplementRetryAt.keys()) if (!active.has(key)) this.aveSupplementRetryAt.delete(key);
    for (const key of this.aveLiveSupplementQueue.keys()) if (!active.has(key)) this.aveLiveSupplementQueue.delete(key);
    for (const key of this.liveProviderFailures.keys()) {
      const tokenKey = key.slice(0, key.lastIndexOf('|'));
      if (!active.has(tokenKey)) this.liveProviderFailures.delete(key);
    }
    while (this.liveHighs.size > LIVE_HIGH_LIMIT) this.liveHighs.delete(this.liveHighs.keys().next().value);
  }
  async refreshDexBatch(chain, items) {
    await this.refreshDexBackgroundBatch(chain, items);
  }
  async refreshDexBackgroundBatch(chain, items) {
    const dexErrors = [];
    let dexMarkets = new Map();
    let timer;
    try {
      const dexItems = items.filter(({ key, token }) => this.liveProviderFailureCount(key, 'dex', token) < LIVE_PROVIDER_FAILURE_LIMIT);
      const dexRequest = dexItems.length ? Dex.batch(Chain.toDex(chain), dexItems.map(({ token }) => token.address), items.some(item=>this.visible.has(item.key))?'live':'background') : Promise.resolve(new Map());
      const dexTimeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('DEX 实时请求超时')), 10_000);
      });
      dexMarkets = await Promise.race([dexRequest, dexTimeout]);
    } catch (error) {
      dexErrors.push(`DEX: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }

    const supplementItems = [];
    const nowMs = Date.now();
    let changed = false;
    for (const item of items) {
      if (this.stopped || !this.repo.current(item.token.chain, item.token.address, item.token.version)) continue;
      const market = dexMarkets.get(item.token.address);
      const previous = this.live.get(item.key);
      // Publish only fresh DEX data. Cached AVE fields do not prove a DEX request succeeded.
      const visible = this.visible.has(item.key);
      const needsSupplement = !positive(market?.price) || !positive(market?.mc);
      const quote = mergeLiveQuote(market ? { ...market, provider: 'dex' } : null, null, previous, { preferAve: false });
      if (positive(market?.price) || positive(market?.mc)) {
        this.noteLiveProviderSuccess(item.token, 'dex');
        if (quote.fieldSources?.logo?.provider === 'dex' && usableLogo(quote.logo)) this.storeLogo(item.token, 'dex', quote.logo);
        this.recordLive(item.token, quote.provider, item.generation, quote);
        changed = true;
      } else if (this.liveProviderFailureCount(item.key, 'dex', item.token) < LIVE_PROVIDER_FAILURE_LIMIT) {
        this.noteLiveProviderFailure(item.token, 'dex', dexErrors.join('；') || '未返回有效价格');
      }
      if (!needsSupplement) continue;
      const retryAt = this.aveSupplementRetryAt.get(item.key) || 0;
      const previousSupplement = visible
        ? hasFreshAveField(previous, 'price', LIVE_OVERLAY_DEX_REFRESH_MS) && hasFreshAveField(previous, 'mc', LIVE_OVERLAY_DEX_REFRESH_MS)
        : LIVE_OVERLAY_QUOTE_FIELDS.some((field) => hasFreshAveField(previous, field, LIVE_SUPPLEMENT_CACHE_MS));
      if (retryAt <= nowMs && !previousSupplement && this.liveProviderFailureCount(item.key, 'ave', item.token) < LIVE_PROVIDER_FAILURE_LIMIT) supplementItems.push({ ...item, dexMarket: market });
    }
    if (changed) this.changed();
    for (const { key, generation } of items) if (this.active.get(key) === generation) this.active.delete(key);
    if (supplementItems.length) void this.refreshAveSupplement(supplementItems, dexErrors);
  }
  async refreshAveSupplement(candidates, dexErrors = []) {
    if (this.stopped) return;
    const nowMs = Date.now();
    const prioritized = [...candidates].sort((a, b) => {
      const aVisible = this.visible.has(a.key) ? 1 : 0;
      const bVisible = this.visible.has(b.key) ? 1 : 0;
      if (aVisible !== bVisible) return bVisible - aVisible;
      const aMissing = Number(!positive(a.dexMarket?.price)) + Number(!positive(a.dexMarket?.mc));
      const bMissing = Number(!positive(b.dexMarket?.price)) + Number(!positive(b.dexMarket?.mc));
      return bMissing - aMissing;
    });
    for (const item of prioritized) {
      if (!this.repo.current(item.token.chain, item.token.address, item.token.version)) continue;
      if ((this.aveSupplementRetryAt.get(item.key) || 0) > nowMs) continue;
      // Keep every missing core quote in a fair queue, with visible rows first.
      this.aveLiveSupplementQueue.set(item.key, { item, dexErrors });
    }
    this.drainAveLiveSupplementQueue();
  }
  async drainAveLiveSupplementQueue() {
    if (this.stopped || this.aveLiveSupplementBusy || Date.now() < this.aveLiveSupplementBackoffUntil) return;
    let queued;
    while (this.aveLiveSupplementQueue.size) {
      const ranked = [...this.aveLiveSupplementQueue.entries()].sort((a, b) => {
        const aVisible = this.visible.has(a[0]) ? 1 : 0;
        const bVisible = this.visible.has(b[0]) ? 1 : 0;
        if (aVisible !== bVisible) return bVisible - aVisible;
        const aMissing = Number(!positive(a[1].item.dexMarket?.price)) + Number(!positive(a[1].item.dexMarket?.mc));
        const bMissing = Number(!positive(b[1].item.dexMarket?.price)) + Number(!positive(b[1].item.dexMarket?.mc));
        return bMissing - aMissing;
      });
      const [key, candidate] = ranked[0];
      this.aveLiveSupplementQueue.delete(key);
      const { token } = candidate.item;
      if (!this.repo.current(token.chain, token.address, token.version)) continue;
      if (this.liveProviderFailureCount(key, 'ave', token) >= LIVE_PROVIDER_FAILURE_LIMIT) continue;
      if ((this.aveSupplementRetryAt.get(key) || 0) > Date.now()) continue;
      queued = candidate;
      break;
    }
    if (!queued) return;
    const { item, dexErrors } = queued;
    const { token, key, generation, dexMarket } = item;
    this.aveLiveSupplementBusy = true;
    this.aveSupplementRetryAt.set(key, Date.now() + LIVE_SUPPLEMENT_RETRY_MS);
    try {
      const market = await this.quote('ave', token.chain, token.address, this.visible.has(key) ? 'live' : 'background');
      if (!this.alive() || !this.repo.current(token.chain, token.address, token.version)) return;
      const latest = this.live.get(key);
      const primary = primaryDexQuote(latest?.version === token.version ? latest.quote : dexMarket);
      // A new AVE fallback replaces old AVE fields, while fresh DEX fields stay primary.
      const quote = mergeLiveQuote(primary, market ? { ...market, provider: 'ave' } : null, latest, { preferAve: false });
      if ((!positive(market?.price) && !positive(market?.mc)) || (!positive(quote.price) && !positive(quote.mc))) {
        this.noteLiveProviderFailure(token, 'ave', '未返回有效价格或市值');
        this.repo.diagnostic('realtime', key, [...dexErrors, 'DEX 和 AVE 均未返回有效价格'].join('；'));
        return;
      }
      this.noteLiveProviderSuccess(token, 'ave');
      if (quote.fieldSources?.logo?.provider === 'ave' && usableLogo(quote.logo)) this.storeLogo(token, 'ave', quote.logo);
      this.recordLive(token, quote.provider, latest?.generation ?? generation, quote);
      if (dexErrors.length || quote.provider === 'ave' || quote.mcSource === 'ave') {
        const source = quote.provider === 'ave' ? 'AVE 行情回退' : 'AVE 补齐缺失字段';
        this.repo.diagnostic('realtime_fallback', key, `${source}${dexErrors.length ? `；${dexErrors.join('；')}` : ''}`);
      }
      this.changed();
    } catch (error) {
      const parked = this.noteLiveProviderFailure(token, 'ave', error?.message || String(error));
      const delay = error instanceof AveSessionRequiredError || error?.deferred
        ? Math.max(300, Number(error?.delay) || 300)
        : Math.max(LIVE_SUPPLEMENT_RETRY_MS / 1000, Math.ceil(Number(error?.retryAfterMs || 0) / 1000));
      if (error instanceof AveSessionRequiredError || error?.deferred) this.aveLiveSupplementBackoffUntil = Date.now() + delay * 1000;
      this.aveSupplementRetryAt.set(key, parked ? this.liveProviderFailures.get(`${key}|ave`).retryAt : Math.max(Date.now() + LIVE_SUPPLEMENT_RETRY_MS, Date.now() + delay * 1000));
      this.repo.diagnostic('realtime_fallback', key, `AVE: ${error?.message || String(error)}${dexErrors.length ? `；${dexErrors.join('；')}` : ''}`);
    } finally {
      this.aveLiveSupplementBusy = false;
      if (!this.stopped && this.aveLiveSupplementQueue.size) {
        setTimeout(() => this.drainAveLiveSupplementQueue(), 300);
      }
    }
  }
  refreshMissingLogos(rows) {
    if (this.stopped || this.logoActive.size >= LOGO_LOOKUP_CONCURRENCY) return;
    for (const token of rows) {
      if (this.logoActive.size >= LOGO_LOOKUP_CONCURRENCY) break;
      const key = `${token.chain}:${token.address}`;
      if (this.logoActive.has(key)) continue;
      const lookup = token.logoLookup && typeof token.logoLookup === 'object' ? token.logoLookup : {};
      if (Number(lookup.attempts || 0) >= LOGO_LOOKUP_MAX_ATTEMPTS) continue;
      const failed = new Set(Array.isArray(lookup.failedUrls) ? lookup.failedUrls : []);
      if (usableLogo(token.logo) && !failed.has(token.logo.trim())) continue;
      if (Number(lookup.nextTryAt || 0) > now()) continue;
      this.logoActive.add(key);
      void this.lookupLogo(token, key, lookup);
    }
  }
  refreshMissingMetadata(rows) {
    if (this.stopped || this.metadataActive.size) return;
    const candidates = rows
      .filter((token) =>
        METADATA_FIELDS.some((field) => missingMetadata(field, token[field])) &&
        Number(token.metadataLookup?.attempts || 0) < METADATA_LOOKUP_MAX_ATTEMPTS &&
        Number(token.metadataLookup?.nextTryAt || 0) <= now(),
      )
      .sort((a, b) =>
        Number(this.visible.has(`${b.chain}:${b.address}`)) - Number(this.visible.has(`${a.chain}:${a.address}`)) ||
        b.lastCall - a.lastCall,
      );
    const token = candidates[0];
    if (!token) return;
    const priority = this.visible.has(`${token.chain}:${token.address}`) ? 'live' : 'background';
    void this.confirmFromMarket(token, { guard: () => !this.stopped && this.repo.current(token.chain, token.address, token.version) }, priority, { allowApi: false })
      .catch((error) => this.alive()&&this.repo.diagnostic('metadata_backfill', `${token.chain}:${token.address}`, error.message));
  }
  refreshHistoricalMetadata() {
    if (this.stopped || Date.now() - this.lastHistoricalMetadataScan < HISTORICAL_METADATA_SCAN_MS) return;
    if (this.logoActive.size >= LOGO_LOOKUP_CONCURRENCY && this.metadataActive.size) return;
    this.lastHistoricalMetadataScan = Date.now();
    const rows = this.repo.all(`
      SELECT t.rowid scanId,t.chain,t.address,t.metadata,t.last_call lastCall,c.version
      FROM tokens t JOIN claims c USING(chain,address)
      WHERE t.rowid>? AND t.last_call<? AND t.verified=1 AND t.blocked=0
        AND c.active=1 AND t.chain<>'?'
      ORDER BY t.rowid LIMIT ?`, this.historicalMetadataCursor,
      now() - LIVE_ACTIVITY_WINDOW_SEC, HISTORICAL_METADATA_PAGE_SIZE);
    if (!rows.length) { this.historicalMetadataCursor = 0; return; }
    for (const row of rows) {
      this.historicalMetadataCursor = row.scanId;
      const token = { ...JSON.parse(row.metadata || '{}'), ...row, verified: 1 };
      const key = `${token.chain}:${token.address}`;
      const lookup = token.logoLookup || {};
      const missingLogo = !usableLogo(token.logo) || lookup.failedUrls?.includes(token.logo?.trim());
      let scheduled = false;
      if (missingLogo && this.logoActive.size < LOGO_LOOKUP_CONCURRENCY &&
          Number(lookup.attempts || 0) < LOGO_LOOKUP_MAX_ATTEMPTS && Number(lookup.nextTryAt || 0) <= now()) {
        this.refreshMissingLogos([token]);
        scheduled = true;
      }
      if (!this.metadataActive.size && !this.logoActive.has(key) &&
          METADATA_FIELDS.some(field => missingMetadata(field, token[field])) &&
          Number(token.metadataLookup?.attempts || 0) < METADATA_LOOKUP_MAX_ATTEMPTS &&
          Number(token.metadataLookup?.nextTryAt || 0) <= now()) {
        this.refreshMissingMetadata([token]);
        scheduled = true;
      }
      // Continue at the next row on the next turn, rather than skipping the
      // rest of this page after selecting the one serial historical lookup.
      if (scheduled) break;
    }
  }
  resetLogoBackoffForExpandedScan() {
    const version = 11;
    if (Number(this.repo.setting('logoLookupStrategyVersion', 0)) >= version) return;
    const inventory = this.repo.view().filter((token) => token.verified && token.chain !== '?');
    const retry = inventory.filter((token) => {
      const failed = token.logoLookup && Array.isArray(token.logoLookup.failedUrls) ? token.logoLookup.failedUrls : [];
      return !usableLogo(token.logo) || failed.includes(token.logo.trim());
    });
    let restored=0;
    this.repo.transaction(() => {
      for (const token of retry) {
        const row = this.repo.get('SELECT metadata FROM tokens WHERE chain=? AND address=?', token.chain, token.address);
        if (!row) continue;
        const metadata = JSON.parse(row.metadata || '{}');
        if (!usableLogo(metadata.logo)) {
          const failure=this.repo.get("SELECT detail FROM diagnostics WHERE category='logo_load_failure' AND token=? ORDER BY id DESC LIMIT 1",`${token.chain}:${token.address}`);
          const source=String(failure?.detail||'').match(/https:\/\/(?:cdn\.dexscreener\.com|www\.iconaves\.com)\/[^\s]+/)?.[0];
          if(source){metadata.logo=source;metadata.sources={...(metadata.sources||{}),logo:{provider:new URL(source).hostname,at:now()}};restored++;}
        }
        metadata.logoLookup = { ...(metadata.logoLookup || {}), attempts: 0, nextTryAt: 0, failedUrls: [], failedAt: {} };
        this.repo.run('UPDATE tokens SET metadata=? WHERE chain=? AND address=?', JSON.stringify(metadata), token.chain, token.address);
      }
      this.repo.set('logoLookupStrategyVersion', version);
    });
    if (retry.length) this.repo.project();
    this.repo.diagnostic('logo_backfill', null, `头像代理规则已统一；${retry.length} 个缺失或旧来源头像进入会话/DEX分批替换，恢复 ${restored} 个图片地址；每个头像失败最多 ${LOGO_LOOKUP_MAX_ATTEMPTS} 次`);
  }
  async lookupLogo(token, key, previousLookup) {
    // Avatar lookup uses the AVE session, then DEX; the Data API stays out of this retry path.
    const providers = ['dex', 'ave'];
    const errors = [];
    const failedAt = previousLookup.failedAt && typeof previousLookup.failedAt === 'object' ? previousLookup.failedAt : {};
    const failed = new Set((Array.isArray(previousLookup.failedUrls) ? previousLookup.failedUrls : []).filter((url) =>
      now() - Number(failedAt[url] || previousLookup.lastAttemptAt || 0) < 6 * 60 * 60,
    ));
    try {
      for (const provider of providers) {
        if (!this.alive() || !this.repo.current(token.chain, token.address, token.version)) return;
        let timer;
        try {
          const market = await Promise.race([
            this.quote(provider, token.chain, token.address, 'background'),
            // Allow the provider enough time to finish its request before moving to fallback.
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error('头像查询超时')), provider === 'ave' ? 25_000 : 10_000); }),
          ]);
          if(!this.alive())return;
          if (usableLogo(market?.logo) && !failed.has(market.logo.trim()) && this.repo.current(token.chain, token.address, token.version)) {
            if (this.storeLogo(token, provider, market.logo)) return;
          }
          errors.push(`${provider}: ${usableLogo(market?.logo) ? '返回了已失效头像' : '未返回头像'}`);
        } catch (error) {
          errors.push(`${provider}: ${error.message}`);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!this.alive()||!this.repo.current(token.chain, token.address, token.version)) return;
      const attempts = Number(previousLookup.attempts || 0) + 1;
      const delay = LOGO_LOOKUP_RETRY_SEC[Math.min(attempts - 1, LOGO_LOOKUP_RETRY_SEC.length - 1)];
      const current = this.repo.get('SELECT metadata FROM tokens WHERE chain=? AND address=?', token.chain, token.address);
      if (!current) return;
      const metadata = JSON.parse(current.metadata || '{}');
      const failedUrls = new Set(Array.isArray(metadata.logoLookup?.failedUrls) ? metadata.logoLookup.failedUrls : []);
      if (usableLogo(metadata.logo) && !failedUrls.has(metadata.logo.trim())) return;
      metadata.logoLookup = {
        attempts,
        lastAttemptAt: now(),
        nextTryAt: attempts >= LOGO_LOOKUP_MAX_ATTEMPTS ? Number.MAX_SAFE_INTEGER : now() + delay,
        lastError: errors.join('；').slice(0, 500),
        failedUrls: [...failed].slice(-8),
        failedAt: Object.fromEntries([...failed].slice(-8).map((url) => [url, Number(failedAt[url] || previousLookup.lastAttemptAt || now())])),
      };
      this.repo.run('UPDATE tokens SET metadata=? WHERE chain=? AND address=?', JSON.stringify(metadata), token.chain, token.address);
      this.repo.project();
      this.invalidateInventory();
      this.repo.diagnostic('logo_lookup', key, `头像来源均未返回可用图片；${errors.join('；')}`);
    } finally {
      this.logoActive.delete(key);
    }
  }
  storeLogo(token, provider, logo) {
    if (!usableLogo(logo) || !this.repo.current(token.chain, token.address, token.version)) return false;
    const current = this.repo.get('SELECT metadata FROM tokens WHERE chain=? AND address=?', token.chain, token.address);
    if (!current) return false;
    const metadata = JSON.parse(current.metadata || '{}');
    const lookup = metadata.logoLookup && typeof metadata.logoLookup === 'object' ? metadata.logoLookup : {};
    const failedUrls = Array.isArray(lookup.failedUrls) ? lookup.failedUrls : [];
    if (failedUrls.includes(logo.trim()) && now() - Number(lookup.failedAt?.[logo.trim()] || lookup.lastAttemptAt || 0) < 6 * 60 * 60) return false;
    if (usableLogo(metadata.logo) && !failedUrls.includes(metadata.logo.trim())) return true;
    metadata.logo = logo.trim();
    metadata.sources = { ...(metadata.sources || {}), logo: { provider, at: now() } };
    metadata.logoLookup = { ...lookup, attempts: 0, lastAttemptAt: now(), nextTryAt: 0, foundAt: now(), failedUrls: failedUrls.filter(url => url !== logo.trim()), failedAt: Object.fromEntries(Object.entries(lookup.failedAt || {}).filter(([url]) => url !== logo.trim())) };
    this.repo.run('UPDATE tokens SET metadata=? WHERE chain=? AND address=?', JSON.stringify(metadata), token.chain, token.address);
    this.repo.project();
    this.invalidateInventory();
    this.repo.diagnostic('logo_backfill', `${token.chain}:${token.address}`, `已从 ${provider} 获取并保存代币头像`);
    this.changed();
    return true;
  }
  reportLogoFailure(chain, address, logo) {
    const url = typeof logo === 'string' ? logo.trim() : '';
    if (!/^https?:\/\//i.test(url) || typeof chain !== 'string' || typeof address !== 'string') throw Error('头像信息无效');
    const token = this.repo.tokenByAddress(address, chain);
    if (!token || !token.verified) return { ok: false, ignored: true };
    const quoteLogo = token.quote?.logo;
    if (token.logo !== url && quoteLogo !== url) return { ok: false, ignored: true };
    const current = this.repo.get('SELECT metadata FROM tokens WHERE chain=? AND address=?', chain, address);
    if (!current) return { ok: false, ignored: true };
    const metadata = JSON.parse(current.metadata || '{}');
    const previous = metadata.logoLookup && typeof metadata.logoLookup === 'object' ? metadata.logoLookup : {};
    const failedAt = { ...(previous.failedAt && typeof previous.failedAt === 'object' ? previous.failedAt : {}), [url]: now() };
    const failedUrls = [...new Set([...(Array.isArray(previous.failedUrls) ? previous.failedUrls : []), url])].slice(-8);
    // Keep the last URL for recovery. The overlay suppresses known-failed URLs,
    // while this lookup searches for a healthy replacement in the background.
    metadata.logoLookup = { ...previous, failedUrls, failedAt, nextTryAt: 0, lastError: '悬浮窗图片加载失败' };
    this.repo.run('UPDATE tokens SET metadata=? WHERE chain=? AND address=?', JSON.stringify(metadata), chain, address);
    this.repo.project();
    this.invalidateInventory();
    this.repo.diagnostic('logo_load_failure', `${chain}:${address}`, `悬浮窗头像加载失败，保留原地址并加入替代来源补查：${url}`);
    this.changed();
    this.refreshMissingLogos([{ ...token, logo: failedUrls.includes(token.logo) ? token.logo : null, logoLookup: metadata.logoLookup }]);
    return { ok: true, retrying: true };
  }
  /** Keep the latest overlay quote and the highest point observed while the overlay watched this claim. */
  recordLive(t, source, generation, m) {
    const key = `${t.chain}:${t.address}`,
      ts = now();
    let entry = this.live.get(key);
    if (!entry || entry.version !== t.version)
      entry = { chain: t.chain, address: t.address, version: t.version, high: null };
    const fieldTimes = ['price', 'mc'].filter(field => positive(m[field]))
      .map(field => Number(m.fieldSources?.[field]?.at || m.receivedAt || ts)).filter(Number.isFinite);
    const receivedAt = fieldTimes.length ? Math.min(ts, ...fieldTimes) : ts;
    Object.assign(entry, { provider: source, quote: m, receivedAt, generation, lastCall: t.lastCall });
    if (positive(m.mc) && (!entry.high || m.mc > entry.high.mc))
      entry.high = { provider: m.mcSource || source, mc: m.mc, price: m.price, at: m.quoteAt ?? ts, quoteAt: m.quoteAt, basis: m.mcBasis, receivedAt: ts };
    if (entry.high) this.liveHighs.set(key, { ...entry.high, version: t.version });
    this.live.set(key, entry);
    if (['ave', 'dex'].includes(source)) {
      const persistKey = `${key}|${source}`;
      const nowMs = Date.now();
      if (nowMs - (this.quotePersistedAt.get(persistKey) || 0) >= LIVE_QUOTE_PERSIST_INTERVAL_MS) {
        try {
          const payload = JSON.stringify({ ...m, provider: source, source, receivedAt });
          this.repo.run(`
            INSERT INTO quotes(chain,address,provider,payload,received_at,generation) VALUES(?,?,?,?,?,?)
            ON CONFLICT(chain,address,provider) DO UPDATE SET
              payload=excluded.payload,received_at=excluded.received_at,generation=excluded.generation
            WHERE quotes.received_at<=excluded.received_at-60
          `, t.chain, t.address, source, payload, receivedAt, Number(generation) || 0);
          this.quotePersistedAt.set(persistKey, nowMs);
        } catch (error) {
          this.repo.diagnostic('quote_cache', key, `保存最近行情快照失败：${String(error?.message ?? error).slice(0, 200)}`);
        }
      }
    }
    this.recordObservedPeak(t, m, source, ts);
    return entry;
  }
  recordObservedPeak(token, quote, source, ts=now()) {
    const row=this.repo.get('SELECT p.baseline,p.observed_peak,c.at FROM price_results p JOIN claims c USING(chain,address) WHERE p.chain=? AND p.address=? AND p.claim_version=? AND c.version=p.claim_version AND c.active=1',token.chain,token.address,token.version);
    if(!row?.baseline)return;
    const base=JSON.parse(row.baseline), provider=quote.fieldSources?.price?.provider||quote.source||source;
    const at=Number(quote.fieldSources?.price?.quoteAt||quote.quoteAt||ts);
    if(provider!==base.provider||!positive(base.price??base.value)||!positive(quote.price)||at<=row.at||at>ts)return;
    const multiple=quote.price/Number(base.price??base.value), previous=row.observed_peak?JSON.parse(row.observed_peak):null;
    if(!positive(multiple))return;
    if(previous&&previous.multiple>=multiple)return;
    this.repo.run('UPDATE price_results SET observed_peak=? WHERE chain=? AND address=? AND claim_version=?',JSON.stringify({provider,price:quote.price,multiple,at,approximate:true,origin:'observed-live-high'}),token.chain,token.address,token.version);
    this.repo.project();
  }
  schedulePeakRefreshes() {
    if(now()-this.lastPeakRefreshScan<60)return;
    this.lastPeakRefreshScan=now();
    const pending=this.repo.get("SELECT COUNT(*) n FROM jobs WHERE lane='capture' AND state IN('QUEUED','RUNNING','BACKOFF') AND json_extract(payload,'$.refresh')=1").n;
    if(pending>=16)return;
    const rows=this.repo.all(`SELECT p.chain,p.address,p.claim_version,j.id,j.payload FROM price_results p JOIN claims c ON c.chain=p.chain AND c.address=p.address AND c.version=p.claim_version JOIN tokens t USING(chain,address) LEFT JOIN jobs j ON j.chain=p.chain AND j.address=p.address AND j.claim_version=p.claim_version AND j.lane='capture' WHERE c.active=1 AND t.verified=1 AND t.blocked=0 AND p.peak IS NOT NULL AND (p.updated_at<=? OR (p.updated_at<=? AND CAST(json_extract(p.peak,'$.coverage.to') AS INTEGER)<?)) AND (j.id IS NULL OR j.state='DONE' OR (j.state='PARKED' AND j.wait IN('nodata','limit') AND j.updated_at<=?)) ORDER BY p.updated_at LIMIT ?`,now()-86400,now()-60,now()-86400,now()-86400,Math.min(4,16-pending));
    let offset=0;
    for(const row of rows){
      const payload=JSON.parse(row.payload||'{}'),batch=this.repo.setting('manualRepairBatchV1',null);
      if(payload.manualBatchId&&batch?.id===payload.manualBatchId){
        if(batch.status==='running'&&this.repo.get("SELECT COUNT(*) n FROM jobs WHERE lane='capture' AND json_extract(payload,'$.manualBatchId')=? AND (state IN('QUEUED','BACKOFF','RUNNING') OR (state='PARKED' AND wait IN('ave_api_key','baseline','verify','chain')))",batch.id).n)continue;
        if(!batch.rows){
          const archived=this.repo.all("SELECT j.id,j.chain,j.address,j.claim_version,j.payload,j.state,j.wait,j.attempts,j.due,j.last_error,j.updated_at,p.baseline,p.peak FROM jobs j LEFT JOIN price_results p ON p.chain=j.chain AND p.address=j.address AND p.claim_version=j.claim_version WHERE j.lane='capture' AND json_extract(j.payload,'$.manualBatchId')=? ORDER BY j.id",batch.id);
          this.repo.set('manualRepairBatchV1',{...batch,status:batch.status==='running'?'complete':batch.status,finishedAt:batch.finishedAt||now(),rows:archived});
        }
      }
      const next=JSON.stringify({stage:'history',refresh:true});
      if(row.id)this.repo.run("UPDATE jobs SET state='QUEUED',payload=?,priority=10,due=?,attempts=0,wait=NULL,last_error=NULL,lease=NULL,lease_until=NULL,updated_at=? WHERE id=? AND (state='DONE' OR (state='PARKED' AND wait IN('nodata','limit')))",next,now()+offset,now(),row.id);
      else this.repo.enqueue('capture',row.chain,row.address,row.claim_version,JSON.parse(next),10,now()+offset);
      offset+=15;
    }
  }
  scheduleNoDataRetries() {
    const ts = now();
    if (ts - this.lastNoDataRetryScan < NO_DATA_RECHECK_SCAN_INTERVAL_SEC) return;
    this.lastNoDataRetryScan = ts;
    const pending = Number(this.repo.get("SELECT COUNT(*) n FROM jobs WHERE lane='capture' AND (state='RUNNING' OR (state IN('QUEUED','BACKOFF') AND due<=?))", ts)?.n || 0);
    if (pending >= 16) return;
    const rows = this.repo.all(`
      SELECT j.id,j.chain,j.address,j.claim_version,j.payload
      FROM jobs j
      JOIN claims c ON c.chain=j.chain AND c.address=j.address AND c.version=j.claim_version AND c.active=1
      JOIN tokens t ON t.chain=j.chain AND t.address=j.address
      LEFT JOIN price_results p ON p.chain=j.chain AND p.address=j.address AND p.claim_version=j.claim_version
      WHERE j.lane='capture' AND j.state='PARKED' AND j.wait IN('nodata','limit')
        AND t.blocked=0 AND t.chain<>'?'
        AND COALESCE(json_extract(t.metadata,'$.manualDisposition'),'')<>'wallet'
        AND COALESCE(json_extract(t.metadata,'$.autoDisposition'),'') NOT IN ('wallet','unlisted')
        AND COALESCE(json_extract(j.payload,'$.manualBatchId'),'')=''
        AND COALESCE(json_extract(j.payload,'$.automaticRechecks'),0) < ?
        AND COALESCE(json_extract(j.payload,'$.nextNoDataRetryAt'),j.updated_at+?)<=?
        AND p.peak IS NULL
      ORDER BY j.updated_at,j.id
      LIMIT ?
    `, NO_DATA_RECHECK_MAX_ATTEMPTS, NO_DATA_RECHECK_INTERVAL_SEC, ts, Math.min(NO_DATA_RECHECK_BATCH_SIZE, 16 - pending));
    let offset = 0;
    for (const row of rows) {
      const payload = JSON.parse(row.payload || '{}');
      const retryNumber = Number(payload.automaticRechecks || 0) + 1;
      payload.automaticRechecks = retryNumber;
      payload.failureAttempts = 0;
      payload.nextNoDataRetryAt = ts + [1800,7200,21600,86400][Math.min(retryNumber - 1,3)];
      const updated = this.repo.run(`
        UPDATE jobs SET state='QUEUED',wait=NULL,due=?,priority=MAX(priority,50),last_error=NULL,updated_at=?,payload=?
        WHERE id=? AND state='PARKED' AND wait IN('nodata','limit')
      `, ts + offset * 30, ts, JSON.stringify(payload), row.id);
      if (updated.changes) this.repo.diagnostic('background_nodata_retry', `${row.chain}:${row.address}`, `无数据或网络重试耗尽，按冷却间隔低优先级补查（第 ${retryNumber}/${NO_DATA_RECHECK_MAX_ATTEMPTS} 次）`);
      offset++;
    }
  }
  liveQuote(chain, address) {
    return this.live.get(`${chain}:${address}`) ?? null;
  }
  liveHigh(chain, address) {
    return this.liveHighs.get(`${chain}:${address}`) ?? null;
  }
  releaseLiveHigh(chain, address, version) {
    const key = `${chain}:${address}`;
    if (this.liveHighs.get(key)?.version === version) this.liveHighs.delete(key);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.liveTimer);
    clearInterval(this.providerMetricsTimer);
    clearInterval(this.chainFallbackTimer);
    clearInterval(this.walletAuditTimer);
    this.flushProviderMetrics();
    clearTimeout(this.visibleTimer);
  }
}


