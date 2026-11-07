import bs58 from "bs58";
import { requestJson } from "./proxy.js";

const RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const MINT_BYTES = 82;
const EXTENSION_HEADER = 165;
const INITIALIZED = 1;
const TIMEOUT_MS = 5_000;
const MAX_ACTIVE = 4;
const CACHE_LIMIT = 5_000;
const MINT_TTL_MS = 24 * 60 * 60_000;
const NEGATIVE_TTL_MS = 60_000;

export type SolanaMintCheck =
  | { kind: "mint" }
  | { kind: "not-mint"; reason: string }
  | { kind: "unknown"; reason: string };

export type SolanaWalletAudit =
  | { kind: "wallet"; signature: string }
  | { kind: "contract"; reason: string }
  | { kind: "unknown"; reason: string };

export interface SolanaMintCheckCache {
  getSolanaMintCheck(address: string): SolanaMintCheck | null;
  setSolanaMintCheck(address: string, result: SolanaMintCheck): void;
}

interface CacheEntry {
  result: SolanaMintCheck;
  expiresAt: number;
}

interface AccountInfo {
  owner?: unknown;
  executable?: unknown;
  data?: unknown;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<SolanaMintCheck>>();
const queue: Array<() => void> = [];
let active = 0;
let requestId = 0;

export function isSolanaPublicKey(value: string): boolean {
  if (typeof value !== "string" || !value) return false;
  try {
    return bs58.decode(value).byteLength === 32;
  } catch {
    return false;
  }
}

/** Mark a Solana key as a wallet only when a system-owned account signed a transaction. */
export async function auditSolanaWalletAddress(address: string): Promise<SolanaWalletAudit> {
  if (!isSolanaPublicKey(address)) return { kind: "unknown", reason: "地址格式不符合 Solana" };
  const accountResponse = await solanaRpc("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]);
  if (!accountResponse.ok) return { kind: "unknown", reason: accountResponse.reason };
  const accountResult = record(accountResponse.value) ? accountResponse.value : null;
  const account = accountResult && record(accountResult.value) ? accountResult.value : null;
  if (account) {
    const owner = account.owner;
    const data = account.data;
    const parsed = record(data) && record(data.parsed) ? data.parsed : null;
    if ((owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) && parsed?.type === "mint")
      return { kind: "contract", reason: "确认是 SPL Token Mint" };
    if (owner !== SYSTEM_PROGRAM || account.executable === true)
      return { kind: "contract", reason: "账户由程序控制或属于非钱包账户，保留核对" };
  }

  const signaturesResponse = await solanaRpc("getSignaturesForAddress", [address, { limit: 10, commitment: "confirmed" }]);
  if (!signaturesResponse.ok) return { kind: "unknown", reason: signaturesResponse.reason };
  if (!Array.isArray(signaturesResponse.value) || signaturesResponse.value.length === 0)
    return { kind: "unknown", reason: account ? "未查到该地址的链上签名记录" : "该地址当前无账户且未查到可验证签名记录" };
  const signatures = signaturesResponse.value.slice(0, 10)
    .map((item) => record(item) && typeof item.signature === "string" ? item.signature : "")
    .filter(Boolean);
  for (let offset = 0; offset < signatures.length; offset += 4) {
    const transactions = await Promise.all(signatures.slice(offset, offset + 4).map((signature) =>
      solanaRpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]),
    ));
    for (let index = 0; index < transactions.length; index++) {
      const transaction = transactions[index];
      if (!transaction.ok) continue;
      const root = record(transaction.value) ? transaction.value : null;
      const tx = root && record(root.transaction) ? root.transaction : null;
      const message = tx && record(tx.message) ? tx.message : null;
      const keys = message && Array.isArray(message.accountKeys) ? message.accountKeys : [];
      const signed = keys.some((entry) => {
        if (typeof entry === "string") return false;
        return record(entry) && entry.pubkey === address && entry.signer === true;
      });
      if (signed) return { kind: "wallet", signature: signatures[offset + index] };
    }
  }
  return { kind: "unknown", reason: "找到链上活动，但没有确认该地址亲自签名；保留待核对" };
}

async function solanaRpc(method: string, params: unknown[]): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  for (const endpoint of RPC_URLS) {
    const id = ++requestId;
    try {
      const response = await requestJson(endpoint, {
        method: "POST",
        timeoutMs: TIMEOUT_MS,
        body: { jsonrpc: "2.0", id, method, params },
      });
      const envelope = record(response.json);
      if (response.status < 200 || response.status >= 300 || !envelope || envelope.jsonrpc !== "2.0" || envelope.id !== id || envelope.error !== undefined)
        continue;
      if (!Object.hasOwn(envelope, "result")) continue;
      return { ok: true, value: envelope.result };
    } catch {}
  }
  return { ok: false, reason: `Solana RPC ${method} 暂时不可用` };
}

/** Confirm an address is an initialized SPL Token or Token-2022 mint on mainnet. */
export function checkSolanaMint(
  address: string,
  persistentCache?: SolanaMintCheckCache,
): Promise<SolanaMintCheck> {
  if (!isSolanaPublicKey(address)) {
    return Promise.resolve({ kind: "not-mint", reason: "invalid Solana public key" });
  }

  const now = Date.now();
  const local = cache.get(address);
  if (local && local.expiresAt > now) return Promise.resolve(local.result);
  cache.delete(address);

  const current = pending.get(address);
  if (current) return current;

  try {
    const stored = persistentCache?.getSolanaMintCheck(address);
    if (stored) {
      remember(address, stored, stored.kind === "mint" ? MINT_TTL_MS : NEGATIVE_TTL_MS);
      return Promise.resolve(stored);
    }
  } catch (error) {
    console.error(`[solana-mint] cache read failed: ${errorMessage(error)}`);
  }

  const task = schedule(() => readMint(address))
    .then((result) => {
      if (result.kind === "mint") remember(address, result, MINT_TTL_MS);
      else if (result.kind === "not-mint") remember(address, result, NEGATIVE_TTL_MS);
      if (result.kind !== "unknown") {
        try {
          persistentCache?.setSolanaMintCheck(address, result);
        } catch (error) {
          console.error(`[solana-mint] cache write failed: ${errorMessage(error)}`);
        }
      }
      return result;
    })
    .finally(() => pending.delete(address));
  pending.set(address, task);
  return task;
}

function remember(address: string, result: SolanaMintCheck, ttl: number): void {
  const now = Date.now();
  cache.set(address, { result, expiresAt: now + ttl });
  if (cache.size <= CACHE_LIMIT) return;
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function schedule<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active++;
      void work().then(resolve, reject).finally(() => {
        active--;
        queue.shift()?.();
      });
    };
    if (active < MAX_ACTIVE) start();
    else queue.push(start);
  });
}

async function readMint(address: string): Promise<SolanaMintCheck> {
  const response = await solanaRpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  if (!response.ok) return { kind: "unknown", reason: response.reason };
  const result = record(response.value);
  if (!result || !Object.hasOwn(result, "value")) {
    return { kind: "unknown", reason: "missing account result" };
  }
  if (result.value === null) return { kind: "not-mint", reason: "account does not exist" };

  const account = record(result.value) as AccountInfo | null;
  if (!account) return { kind: "unknown", reason: "malformed account info" };
  if (account.executable === true) return { kind: "not-mint", reason: "account is executable" };
  if (account.owner !== TOKEN_PROGRAM && account.owner !== TOKEN_2022_PROGRAM) {
    return { kind: "not-mint", reason: "account is not owned by a token program" };
  }

  const data = account.data;
  if (!Array.isArray(data) || typeof data[0] !== "string" || data[1] !== "base64") {
    return { kind: "unknown", reason: "malformed token account data" };
  }
  const bytes = decodeBase64(data[0]);
  if (!bytes) return { kind: "unknown", reason: "invalid base64 token account data" };
  if (bytes.length < MINT_BYTES || bytes[45] !== INITIALIZED) {
    return { kind: "not-mint", reason: "account data is not an initialized Mint" };
  }
  if (bytes.readUInt32LE(0) > 1 || bytes.readUInt32LE(46) > 1) {
    return { kind: "not-mint", reason: "invalid Mint layout" };
  }

  if (account.owner === TOKEN_PROGRAM) {
    return bytes.length === MINT_BYTES
      ? { kind: "mint" }
      : { kind: "not-mint", reason: "unexpected SPL Token Mint length" };
  }
  if (bytes.length === MINT_BYTES) return { kind: "mint" };
  const validExtensionLayout = bytes.length > EXTENSION_HEADER &&
    bytes.subarray(MINT_BYTES, EXTENSION_HEADER).every((byte) => byte === 0) &&
    bytes[EXTENSION_HEADER] === INITIALIZED;
  return validExtensionLayout
    ? { kind: "mint" }
    : { kind: "not-mint", reason: "unexpected Token-2022 account layout" };
}

function decodeBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
