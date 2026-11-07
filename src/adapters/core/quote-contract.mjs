/** Shared runtime guardrails; kept loader-free for the statistics worker. */
export const MAX_PLAUSIBLE_MARKET_CAP_USD = 1e15;
export function plausibleMarketCap(mc, fdv) {
  const cap=Number(mc), diluted=Number(fdv);
  return Number.isFinite(cap)&&cap>0&&cap<=MAX_PLAUSIBLE_MARKET_CAP_USD&&
    (!(Number.isFinite(diluted)&&diluted>0)||cap<=diluted*1.05);
}
export function sanitizeMarketQuote(quote) {
  const mcSource=quote?.fieldSources?.mc?.provider,fdvSource=quote?.fieldSources?.fdv?.provider;
  const comparableFdv=mcSource&&fdvSource&&mcSource!==fdvSource?undefined:quote?.fdv;
  if (!quote || quote.mc == null || plausibleMarketCap(quote.mc, comparableFdv)) return quote;
  const cleaned={...quote,mc:undefined,fieldSources:{...quote.fieldSources}};
  delete cleaned.fieldSources.mc;
  return cleaned;
}
