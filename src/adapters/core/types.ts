/** Contracts at the boundary between provider adapters and X-ray services. */

export interface Market {
  symbol?: string;
  name?: string;
  logo?: string;
  chain?: string;
  price?: number;
  mc?: number;
  fdv?: number;
  circulatingSupply?: number;
  poolId?: string;
  quoteAt?: number;
  receivedAt?: number;
  timePrecision?: "second" | "minute" | "request" | "unknown";
  endpoint?: string;
  mcSource?: string;
  mcBasis?: string;
  liq?: number;
  change5m?: number;
  change1h?: number;
  change24h?: number;
  holders?: number;
  priceAgo?: Record<number, number>;
  source: "ave" | "dex";
  updatedAt: number;
}

export interface SenderFilter {
  includeSenderIds: string[];
  blockedSenderIds: string[];
}

export interface TelegramMonitorGroup {
  peerId: string;
  title: string;
  kind?: "group" | "channel";
}

export interface AveQueryParams {
  chain: string;
  address: string;
  mode?: "detail" | "kline";
  interval?: number;
  from?: number;
  to?: number;
}

export interface AveQueryResult {
  chain: string;
  address: string;
  status: number;
  body: string;
  endpoint: string;
  elapsedMs?: number;
  error?: string;
}


