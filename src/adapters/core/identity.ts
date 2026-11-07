const CHAIN_ALIASES = new Map<string, string>([
  ["solana", "sol"],
  ["ethereum", "eth"],
  ["bnb", "bsc"],
  ["binance", "bsc"],
  ["bnb chain", "bsc"],
  ["arb", "arbitrum"],
  ["op", "optimism"],
]);

/** Canonicalize only EVM addresses; base58 and case-sensitive identifiers stay intact. */
export function normalizeTokenAddress(address: string): string {
  const value = address.trim();
  return value.slice(0, 2).toLowerCase() === "0x" ? value.toLowerCase() : value;
}

/** Return the key used by quote providers and token storage. */
export function tokenKey(chain: string | null | undefined, address: string): string {
  return `${tokenChainKey(chain)}:${normalizeTokenAddress(address)}`;
}

/** Map provider spellings to one stable chain key without guessing unknown names. */
export function tokenChainKey(chain: string | null | undefined): string {
  const key = typeof chain === "string" ? chain.trim().toLowerCase() : "";
  return CHAIN_ALIASES.get(key) ?? (key || "?");
}
