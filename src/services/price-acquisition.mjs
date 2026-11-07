import { now, positive, CAPTURE_QUIET_WINDOW_SEC, CAPTURE_REFRESH_INTERVAL_SEC, RECENT_WINDOW_SEC } from '../domain/rules.mjs';
import { DeferredError, NoDataError, WaitError } from '../infra/worker.mjs';

const QUIET_WINDOW_SEC = CAPTURE_QUIET_WINDOW_SEC;
const MINUTE = 60;

/**
 * Stores one call-time denominator and one post-call high for the owning call.
 * The denominator is captured once when the call arrives. The high is captured
 * incrementally after the call, with bounded refreshes while active. Observed
 * live highs are stored separately and never become confirmed statistics.
 */
export class PriceAcquisition {
  constructor(market) {
    this.market = market;
    this.repo = market.repo;
  }

  result(token) {
    return this.repo.get(
      'SELECT * FROM price_results WHERE chain=? AND address=? AND claim_version=?',
      token.chain,
      token.address,
      token.version,
    );
  }

  providers() {
    return ['ave'];
  }

  async historyBars(provider, token, from, to, resolution, intervalSeconds, signal) {
    const span = intervalSeconds * 299;
    const ranges = [];
    const unique = new Map();
    for (let start = from; start < to; start += span) {
      const end = Math.min(to, start + span);
      if (signal?.aborted) throw signal.reason || new Error('行情查询已取消');
      const bars = await this.market.priceBars(provider, token, start, end, resolution, intervalSeconds, signal);
      for (const bar of bars) unique.set(Number(bar.time), bar);
      ranges.push({ from: start, to: end });
    }
    return { bars: [...unique.values()].sort((a, b) => a.time - b.time), ranges };
  }

  async baseline(ctx) {
    const token = this.market.token(ctx);
    if (this.result(token)?.baseline) {
      if (!token.verified && ctx.guard()) {
        this.repo.run("UPDATE tokens SET verified=1 WHERE chain=? AND address=?", token.chain, token.address);
        this.market.statistics.recompute(token.chain, token.address, token.version);
        this.market.statistics.publish();
      }
      return;
    }

    // Confirm and save token identity before asking the historical providers.
    // A slow/expired baseline request must not leave a known, queryable token in
    // the "unconfirmed address" list. This step uses the normal AVE -> DEX
    // metadata path and only verifies when a provider returns positive market
    // evidence together with a token name or symbol.
    if (!token.verified) {
      // A fresh shout must be confirmed on the live lane so it can join the
      // visible overlay refresh queue before slower historical baseline work.
      await this.market.confirmFromMarket(token, ctx, 'live');
      if (!ctx.guard()) return;
    }

    const live = this.market.liveQuote(token.chain, token.address);
    const liveQuote = live?.quote;
    const liveAt = Number(liveQuote?.quoteAt || live?.receivedAt || 0);
    if (
      live &&
      live.version === token.version &&
      ['ave', 'dex'].includes(live.provider) &&
      live.provider === liveQuote?.source &&
      positive(liveQuote?.price) &&
      liveAt <= token.at &&
      token.at - liveAt <= 120
    ) {
      this.saveBaseline(token, {
        provider: live.provider,
        unit: 'price',
        value: liveQuote.price,
        price: liveQuote.price,
        at: liveAt,
        approximate: true,
        origin: 'recent-live-quote-before-call',
      }, ctx);
      return;
    }

    const failures = [];
    const deferred = [];
    for (const provider of this.providers()) {
      if (!ctx.guard()) return;
      try {
        const from = Math.max(0, token.at - QUIET_WINDOW_SEC);
        const bars = await this.market.priceBars(
          provider, token, from, token.at, '1m', MINUTE, ctx.signal,
        );
        const candle = bars
          .filter((bar) => positive(bar.close) && bar.time + MINUTE <= token.at)
          .sort((a, b) => b.time - a.time)[0];
        if (!candle) {
          this.repo.diagnostic('baseline_provider_empty', `${token.chain}:${token.address}`, `${provider}: 喊单前无有效已完成K线`);
          continue;
        }
        if (failures.length) this.repo.diagnostic('baseline_provider_fallback', `${token.chain}:${token.address}`, `${provider} 回退成功；首选来源失败：${failures.join('；')}`);
        this.saveBaseline(token, {
          provider, unit: 'price', value: candle.close, price: candle.close,
          at: candle.time + MINUTE,
          approximate: token.at - (candle.time + MINUTE) > 120,
          origin: 'last-completed-price-candle-before-call',
        }, ctx);
        return;
      } catch (error) {
        if(!ctx.guard())return;
        if (error instanceof WaitError || error?.wait) throw error;
        if (error instanceof DeferredError || error?.deferred) {
          deferred.push({ message: `${provider}: ${error.message}`, delay: error.delay });
          continue;
        }
        failures.push(`${provider}: ${error.message}`);
        this.repo.diagnostic('baseline', `${token.chain}:${token.address}`, failures.at(-1));
      }
    }
    if (failures.length) {
      // A provider timeout is a failed query, not proof that no market data exists.
      // Automatic work ends after this bounded two-source round; manual repair
      // may retry transient failures up to its existing three-attempt limit.
      throw new Error(`喊单前行情查询失败：${failures.join('；')}`);
    }
    if (deferred.length) throw new DeferredError(deferred.map(e => e.message).join('；'), Math.max(...deferred.map(e => Number(e.delay) || 30)));

    // A shout can arrive before a token has its first trade. In that case
    // there is no honest call-time denominator. Keep a clearly marked launch
    // reference from the first completed post-call candle so the token can be
    // reviewed, while approximate baselines stay out of formal rankings.
    const retryAt = token.at + QUIET_WINDOW_SEC;
    const launchSearchSec = now() >= retryAt ? QUIET_WINDOW_SEC : 299 * MINUTE;
    const launchEnd = Math.min(now(), token.at + launchSearchSec);
    if (launchEnd > token.at + 1) {
      const { bars } = await this.historyBars(
        'ave', token, token.at + 1, launchEnd, '1m', MINUTE, ctx.signal,
      );
      const firstTrade = bars
        .filter((bar) => bar.time > token.at && bar.time + MINUTE <= now() && positive(bar.close))
        .sort((a, b) => a.time - b.time)[0];
      if (firstTrade) {
        this.repo.diagnostic('baseline_launch_reference', `${token.chain}:${token.address}`, '喊单早于首笔可用行情；使用首根喊后K线作开池参考，排除正式统计');
        this.saveBaseline(token, {
          provider: 'ave', unit: 'price', value: firstTrade.open, price: firstTrade.open,
          at: firstTrade.time, approximate: true,
          origin: 'first-traded-candle-after-call',
        }, ctx);
        return;
      }
    }
    // Empty baselines get a bounded, increasing retry cadence while the token launches.
    const emptyAttempts = Number(ctx.job.payload.baselineEmptyAttempts || 0) + 1;
    if (now() < retryAt && emptyAttempts <= 4) return { again: [300, 1800, 7200, 21600][emptyAttempts - 1], payload: { stage: 'baseline', baselineEmptyAttempts: emptyAttempts } };
    throw new NoDataError('AVE 没有返回可用的喊单前已完成价格K线');
  }

  saveBaseline(token, baseline, ctx) {
    if (!ctx.guard()) return;
    this.repo.transaction(() => {
      this.repo.run("UPDATE tokens SET verified=1 WHERE chain=? AND address=?", token.chain, token.address);
      this.repo.run(
        `INSERT INTO price_results(chain,address,claim_version,baseline,updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(chain,address) DO UPDATE SET
         claim_version=excluded.claim_version,
         baseline=CASE WHEN price_results.claim_version=excluded.claim_version
           THEN COALESCE(price_results.baseline,excluded.baseline) ELSE excluded.baseline END,
         peak=CASE WHEN price_results.claim_version=excluded.claim_version
           THEN price_results.peak ELSE NULL END,
         observed_peak=CASE WHEN price_results.claim_version=excluded.claim_version
           THEN price_results.observed_peak ELSE NULL END,
         updated_at=excluded.updated_at`,
        token.chain,
        token.address,
        token.version,
        JSON.stringify(baseline),
        now(),
      );
      this.market.statistics.recompute(token.chain, token.address, token.version);
    });
    this.market.statistics.publish();
  }

  async history(ctx) {
    const token = this.market.token(ctx);
    const row = this.result(token);
    if (!row?.baseline) throw new WaitError('等待喊单时价格基准', 'baseline');

    const manual = Boolean(ctx.job.payload.manualBatchId);

    const baseline = JSON.parse(row.baseline);
    const previous = row.peak ? JSON.parse(row.peak) : null;
    const emptyRanges=[...(previous?.coverage?.emptyRanges||ctx.job.payload.historyEmptyRanges||[])];
    const cursor = Math.max(Number(previous?.coverage?.to || 0),Number(ctx.job.payload.historyCursor||0));
    // Revisit the last partial five-minute candle; never skip its completed high.
    const from = cursor > token.at ? Math.max(token.at + 1, Math.floor(cursor / 300) * 300) : token.at + 1;
    const end = Math.min(now(), from + 86400);
    if (end <= from) throw new NoDataError('喊单后没有可查询的行情区间');

    const errors = [];
    const deferred = [];

    let best = null;
    let hadUsableResponse = false;
    let completedWindow = false;
    let historyAnchor = null;
    for (const provider of this.providers()) {
      if (!ctx.guard()) return;
      const savedAnchor=ctx.job.payload.historyBaseline??previous?.coverage?.anchor;
      let denominator = provider === baseline.provider && (baseline.unit ?? 'price') === 'price'
        ? { value: Number(baseline.value), at: baseline.at, approximate: baseline.approximate }
        : savedAnchor?.provider===provider&&positive(savedAnchor.value)
          ? savedAnchor
        : previous?.provider===provider&&positive(previous.baselinePrice)
          ? {value:previous.baselinePrice,at:previous.baselineAt,approximate:true}:null;
      if (denominator && !positive(denominator.value)) denominator = null;
      try {
        if (!denominator) {
          const anchors = await this.market.priceBars(
            provider, token, Math.max(0, token.at - QUIET_WINDOW_SEC), token.at, '1m', MINUTE, ctx.signal,
          );
          const anchor = anchors
            .filter((bar) => positive(bar.close) && bar.time + MINUTE <= token.at)
            .sort((a, b) => b.time - a.time)[0];
          if (!anchor) {
            hadUsableResponse = true;
            this.repo.diagnostic('history_provider_empty', `${token.chain}:${token.address}`, `${provider}: 没有同源喊单基准，跳过以避免跨来源计算`);
            continue;
          }
          denominator = {
            value: anchor.close,
            at: anchor.time + MINUTE,
            approximate: token.at - (anchor.time + MINUTE) > 120,
          };
        }
        historyAnchor={...denominator,provider};
        // Refine the first, call-crossing 5-minute window with completed
        // 1-minute candles whose opening time is strictly after the call.
        // The minute containing the call itself remains excluded because its
        // high can include pre-call trading.
        const firstFiveMinuteBoundary = Math.min(end, Math.ceil((token.at + 1) / 300) * 300);
        const candidates = [];
        let fineRanges = [];
        if (firstFiveMinuteBoundary > from) {
          const fine = await this.historyBars(provider, token, from, firstFiveMinuteBoundary, '1m', MINUTE, ctx.signal);
          hadUsableResponse = true;
          fineRanges = fine.ranges;
          candidates.push(...fine.bars
            .filter((bar) => bar.time > token.at && bar.time >= from && bar.time + MINUTE <= Math.min(end, firstFiveMinuteBoundary) && positive(bar.high))
            .map((bar) => ({ bar, intervalSeconds: MINUTE })));
        }

        const fiveMinuteFrom = Math.max(from, firstFiveMinuteBoundary);
        let coarseRanges = [];
        if (fiveMinuteFrom < end) {
          const coarse = await this.historyBars(provider, token, fiveMinuteFrom, end, '5m', 300, ctx.signal);
          hadUsableResponse = true;
          coarseRanges = coarse.ranges;
          candidates.push(...coarse.bars
            .filter((bar) => bar.time >= fiveMinuteFrom && bar.time + 300 <= end && positive(bar.high))
            .map((bar) => ({ bar, intervalSeconds: 300 })));
        }
        completedWindow=true;
        const peak = candidates
          .sort((a, b) => b.bar.high - a.bar.high || b.bar.time - a.bar.time)[0];
        // Only completed candles become durable evidence. The boundary
        // candle is deliberately approximate, and its resolution is recorded.
        if (!positive(peak?.bar?.high)) continue;
        const candidate = {
          provider, unit: 'price', price: peak.bar.high,
          at: peak.bar.time + peak.intervalSeconds - 1,
          intervalStart: peak.bar.time,
          intervalSeconds: peak.intervalSeconds,
          multiple: peak.bar.high / denominator.value,
          baselinePrice: denominator.value,
          baselineAt: denominator.at,
          approximate: true,
          origin: 'segmented-post-call-history-query',
          coverage: {
            from:token.at+1, to: end, requestComplete: true,emptyRanges,
            anchor:historyAnchor,
            boundary: { from, to: firstFiveMinuteBoundary, intervalSeconds: 60, ranges: fineRanges },
            history: { from: fiveMinuteFrom, to: end, intervalSeconds: 300, ranges: coarseRanges },
          },
        };
        if (positive(candidate.multiple) && (!best || candidate.multiple > best.multiple)) best = candidate;
      } catch (error) {
        if(!ctx.guard())return;
        if (error instanceof WaitError || error?.wait) throw error;
        if (error instanceof DeferredError || error?.deferred) {
          deferred.push({ message: `${provider}: ${error.message}`, delay: error.delay });
          continue;
        }
        errors.push(`${provider}: ${error.message}`);
        this.repo.diagnostic('history', `${token.chain}:${token.address}`, errors.at(-1));
      }
    }
    if (!ctx.guard()) return;
    // The owning claim is guarded by its version. A later mention of the same
    // token does not invalidate already completed history for that first shout.
    const latest = this.market.token(ctx);
    const nextPage = () => end < now() - 300
      ? { again: manual ? 1 : 60, payload: { stage: 'history', refresh: !manual, historyCursor: end, historyBaseline: historyAnchor, historyEmptyRanges: emptyRanges.slice(-32), failureAttempts: 0, manualAttempts: 0 } }
      : !manual && Number(latest.last_call || latest.at) >= now() - RECENT_WINDOW_SEC
      ? { again: CAPTURE_REFRESH_INTERVAL_SEC, payload: { stage: 'history', refresh: true, historyCursor: end, historyBaseline: historyAnchor, historyEmptyRanges: emptyRanges.slice(-32), failureAttempts: 0 } }
      : undefined;
    if (best) {
      if (errors.length) this.repo.diagnostic('history_provider_fallback', `${token.chain}:${token.address}`, `已从有效来源取得喊后高点；其他来源：${errors.join('；')}`);
      this.savePeak(token, best, ctx);
      this.market.releaseLiveHigh(token.chain, token.address, token.version);
      // A long backlog is completed in bounded pages, with saved progress.
      // Neither a manual batch nor an automatic catch-up ends after page one.
      return nextPage();
    }
    this.market.releaseLiveHigh(token.chain, token.address, token.version);
    if (errors.length) throw new Error(`历史行情查询失败：${errors.join('；')}`);
    if (deferred.length) throw new DeferredError(deferred.map(e => e.message).join('；'), Math.max(...deferred.map(e => Number(e.delay) || 30)));
    const observed = row.observed_peak ? JSON.parse(row.observed_peak) : null;
    if (
      observed && observed.provider === baseline.provider &&
      positive(observed.price) && positive(observed.multiple) && observed.at > token.at
    ) {
      const reference = {
        provider: observed.provider, unit: 'price', price: observed.price,
        at: observed.at, multiple: observed.multiple,
        baselinePrice: Number(baseline.value), baselineAt: baseline.at,
        approximate: true, origin: 'observed-live-high-fallback',
        coverage: { from: token.at + 1, to: end, requestComplete: false, observedOnly: true },
      };
      this.repo.diagnostic('history_observed_fallback', `${token.chain}:${token.address}`, '历史K线未返回可计算高点；保存已有同源实时观察高点作参考，不计入正式统计');
      this.savePeak(token, reference, ctx);
      return nextPage();
    }
    if(completedWindow){
      // A valid empty day is a checked gap, not proof that all later days are empty.
      // Persist its cursor separately from the high; transport errors never enter here.
      emptyRanges.push({from,to:end});
      if(previous)this.savePeak(token,{...previous,coverage:{...previous.coverage,from:previous.coverage?.from??token.at+1,to:end,anchor:historyAnchor,emptyRanges:emptyRanges.slice(-32)}},ctx);
      const next=nextPage();
      if(next)return next;
      if(previous)return;
    }
    throw new NoDataError(hadUsableResponse ? 'AVE 未取得可计算的喊后高点' : 'AVE 喊单后区间未取得有效行情');
  }

  savePeak(token, peak, ctx) {
    if (!ctx.guard()) return;
    const row=this.result(token), previous=row?.peak?JSON.parse(row.peak):null;
    // Empty/lower refreshes cannot erase a previously confirmed high.
    if (!peak) return;
    if (previous && Number(previous.multiple) >= Number(peak.multiple)) {
      peak={...previous,coverage:{...peak.coverage,from:previous.coverage?.from??token.at+1}};
    } else if (previous?.coverage) {
      peak={...peak,coverage:{...peak.coverage,from:previous.coverage.from??token.at+1}};
    }
    this.repo.run(
      'UPDATE price_results SET peak=?,updated_at=? WHERE chain=? AND address=? AND claim_version=?',
      peak ? JSON.stringify(peak) : null,
      now(),
      token.chain,
      token.address,
      token.version,
    );
    this.market.statistics.publish();
  }
}
