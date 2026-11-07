export const now = () => Math.floor(Date.now() / 1000);
export const RECENT_WINDOW_SEC = 24 * 60 * 60;
export const CAPTURE_QUIET_WINDOW_SEC = 24 * 60 * 60;
export const CAPTURE_REFRESH_INTERVAL_SEC = 15 * 60;
export const BASELINE_MAX_AGE_SEC = 6 * 60 * 60;
export const positive = (v) =>
  Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
export function tokenKey(chain, address) {
  return `${chain}:${address}`;
}
export function normalize(chain, address) {
  if (typeof address !== "string") throw Error("合约地址格式无效");
  address = address.trim();
  if (/^0x[\da-f]{40}$/i.test(address)) return address.toLowerCase();
  if (chain === "sol" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
    return address;
  throw Error("合约地址格式无效");
}
export function canonicalChain(value) {
  const s = String(value ?? "?").trim().toLowerCase()||'?';
  return (
    { ethereum: "eth", solana: "sol", 'bnb chain':'bsc',bnb:'bsc',binance:'bsc',arb: "arbitrum", op: "optimism" }[s] ?? s
  );
}
export function compatible(a, b) {
  if (
    !positive(a?.mc) ||
    !positive(a?.price) ||
    !positive(b?.mc) ||
    !positive(b?.price)
  )
    return false;
  const ratio = a.mc / a.price / (b.mc / b.price);
  return Number.isFinite(ratio) && ratio >= 1 / 1.2 && ratio <= 1.2;
}
export function validPoint(p, clock = now()) {
  return (
    p &&
    // AVE remains valid here only so existing historical rows still render.
    ["ave", "ave_api", "dex"].includes(p.provider) &&
    positive(p.mc) &&
    p.mc <= 1e15 &&
    positive(p.price) &&
    p.mc > p.price * 100 &&
    Number.isFinite(p.at) &&
    p.at <= clock
  );
}
export function baselineDecision(p, callAt) {
  if (!validPoint(p))
    return { accepted: false, reason: "invalid_units_or_time" };
  if (p.at > callAt) return { accepted: false, reason: "after_first_call" };
  const age = callAt - p.at;
  if (age > BASELINE_MAX_AGE_SEC) return { accepted: false, reason: "baseline_too_old" };
  if (p.precision === "request")
    return { accepted: false, reason: "request_is_not_historical_quote" };
  if (age > 120 && !["last-trade"].includes(p.precision))
    return { accepted: false, reason: "baseline_outside_window" };
  const approximate =
    p.estimated ||
    p.basis === "supply-derived" ||
    age > 120 ||
    p.precision !== "second";
  return {
    accepted: true,
    approximate: !!approximate,
    reason: approximate ? "approximate_baseline" : "exact_baseline",
  };
}
export function peakDecision(p, baseline, callAt, corroborating = []) {
  if (!validPoint(p) || p.at <= callAt)
    return { accepted: false, reason: "invalid_post_call_point" };
  if (p.intervalStart != null && p.intervalStart <= callAt)
    return { accepted: false, reason: "candle_overlaps_first_call" };
  if (baseline && !compatible(baseline, p))
    return { accepted: false, reason: "supply_mismatch" };
  const cross = baseline && p.provider !== baseline.provider;
  const confirmed =
    cross &&
    corroborating.some(
      (q) =>
        q.provider === baseline.provider &&
        !q.estimated &&
        q.basis !== "supply-derived" &&
        (q.intervalStart == null || q.intervalStart > callAt) &&
        validPoint(q) &&
        compatible(baseline, q) &&
        q.at > callAt &&
        Math.abs(q.at - p.at) <= 60 &&
        Math.abs(q.mc / p.mc - 1) <= 0.01,
    );
  const formal =
    !!baseline &&
    !baseline.approximate &&
    !p.estimated &&
    p.basis !== "supply-derived" &&
    (!cross || confirmed);
  return {
    accepted: true,
    formal,
    reason: formal ? "verified_peak" : "reference_peak",
  };
}
export function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y),
    m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function rank(rows) {
  const buckets = new Map();
  for (const r of rows) {
    let b = buckets.get(r.senderKey);
    if (!b) {
      b = {
        senderKey: r.senderKey,
        name: r.sender,
        total: 0,
        values: [],
        best: null,
      };
      buckets.set(r.senderKey, b);
    }
    b.total++;
    // New rankings are based only on the single post-call capture result.
    const x=r.priceMultiple;
    if (x != null) {
      b.values.push(x);
      if (!b.best || x > b.best.priceMultiple) b.best = r;
    }
  }
  return [...buckets.values()]
    .map((b) => ({
      senderKey: b.senderKey,
      name: b.name,
      total: b.total,
      valid: b.values.length,
      wins: b.values.filter((v) => v >= 2).length,
      winRate: b.values.length
        ? b.values.filter((v) => v >= 2).length / b.values.length
        : null,
      average: b.values.length
        ? b.values.reduce((a, v) => a + v, 0) / b.values.length
        : null,
      median: median(b.values),
      best: b.best,
    }))
    .filter((b) => b.valid > 0)
    .sort(
      (a, b) =>
        (b.average ?? -1) - (a.average ?? -1) ||
        b.valid - a.valid ||
        a.senderKey.localeCompare(b.senderKey),
    );
}
