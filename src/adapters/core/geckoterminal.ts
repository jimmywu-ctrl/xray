import { requestJson } from "./proxy.js";
import { ApiRateLimitError, RequestScheduler } from "./request-scheduler.js";

const ROOT = "https://api.geckoterminal.com/api/v2";
const REQUEST_TIMEOUT_MS = 10_000;
const scheduler = new RequestScheduler("geckoterminal", 1, 1, 12_000, 1);

const NETWORKS: Record<string, string> = {
  sol: "solana",
  eth: "eth",
  bsc: "bsc",
  base: "base",
  robinhood: "robinhood",
  xlayer: "x-layer",
  arc: "arc",
  monad: "monad",
  polygon: "polygon_pos",
  avalanche: "avax",
  arbitrum: "arbitrum",
  optimism: "optimism",
  opbnb: "opbnb",
  zksync: "zksync",
  linea: "linea",
  scroll: "scroll",
  blast: "blast",
  mantle: "mantle",
  sonic: "sonic",
  sui: "sui-network",
  ton: "ton",
};

type TokenInfo = {
  data?: {
    attributes?: {
      image_url?: unknown;
      image?: { thumb?: unknown; small?: unknown; large?: unknown };
    };
  };
};

function imageUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim())
    ? value.trim()
    : undefined;
}

/** Low-priority metadata-only fallback, paced to GeckoTerminal's public API limit. */
export async function geckoTokenLogo(chain: string, address: string): Promise<string | undefined> {
  const network = NETWORKS[chain.toLowerCase()];
  if (!network) return undefined;
  return scheduler.run(
    `${network}:${address.toLowerCase()}`,
    "background",
    async () => {
      const url = `${ROOT}/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(address)}/info`;
      const response = await requestJson(url, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: { Accept: "application/json;version=20230203" },
      });
      if (response.status === 429) {
        throw new ApiRateLimitError(response.retryAfterMs, "GeckoTerminal HTTP 429");
      }
      if (response.status < 200 || response.status >= 300) return undefined;
      const attributes = (response.json as TokenInfo | null)?.data?.attributes;
      return imageUrl(attributes?.image?.large)
        ?? imageUrl(attributes?.image?.small)
        ?? imageUrl(attributes?.image?.thumb)
        ?? imageUrl(attributes?.image_url);
    },
    60_000,
    { bucket: "geckoterminal-public", intervalMs: 6_000 },
  );
}
