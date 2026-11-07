import { requestJson } from "./proxy.js";
import { tokenChainKey } from "./identity.js";

export type Erc20Verdict = "erc20" | "non-erc20" | "unknown";
export type EvmWalletAudit =
  | {
      kind: "wallet";
      network: string;
      nonce?: string;
      checkedNetworks: string[];
      evidence?: { type: "eip7702"; delegate: string } | { type: "funded-eoa"; balanceWei: string };
      reason: string;
    }
  | { kind: "contract"; networks: string[]; checkedNetworks: string[]; reason: string }
  | { kind: "unknown"; reason: string; checkedNetworks: string[] };

type RpcNetwork = { slug: string; chainId: bigint; endpoint: string };
type RpcOutcome = { ok: true; value: unknown } | { ok: false; kind: "revert" | "unavailable"; reason: string };

const NETWORKS: readonly RpcNetwork[] = [
  { slug: "eth", chainId: 1n, endpoint: "https://ethereum-rpc.publicnode.com" },
  { slug: "bsc", chainId: 56n, endpoint: "https://bsc-dataseed.bnbchain.org" },
  { slug: "base", chainId: 8453n, endpoint: "https://mainnet.base.org" },
  { slug: "monad", chainId: 143n, endpoint: "https://rpc.monad.xyz" },
  { slug: "robinhood", chainId: 4663n, endpoint: "https://rpc.mainnet.chain.robinhood.com" },
  { slug: "arc", chainId: 5042n, endpoint: "https://rpc.mainnet.arc.io" },
];

export const PUBLIC_RPC = NETWORKS.map(({ slug, endpoint, chainId }) => ({
  slug,
  url: endpoint,
  chainId: Number(chainId),
}));

const TIMEOUT_MS = 5_000;
const ADDRESS = /^0x[\da-f]{40}$/i;
const HEX_BYTES = /^0x(?:[\da-f]{2})*$/i;
const HEX_WORD = /^0x[\da-f]{64}$/i;
const HEX_QUANTITY = /^0x(?:0|[1-9a-f][\da-f]*)$/i;
const OWNER = "0x000000000000000000000000000000000000dEaD";
const SPENDER = "0x000000000000000000000000000000000000bEEF";
const TOKEN_READS = [
  { name: "balanceOf", calldata: `0x70a08231${word(OWNER)}` },
  { name: "totalSupply", calldata: "0x18160ddd" },
  { name: "allowance", calldata: `0xdd62ed3e${word(OWNER)}${word(SPENDER)}` },
] as const;
let requestId = 0;

function word(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rpcQuantity(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) return undefined;
  try { return BigInt(value); } catch { return undefined; }
}

function isExplicitRevert(code: unknown, message: unknown): boolean {
  return code === 3 || (typeof message === "string" && /execution reverted|\brevert\b/i.test(message));
}

async function callRpc(endpoint: string, method: string, params: unknown[]): Promise<RpcOutcome> {
  const id = ++requestId;
  try {
    const response = await requestJson(endpoint, {
      method: "POST",
      timeoutMs: TIMEOUT_MS,
      body: { jsonrpc: "2.0", id, method, params },
    });
    if (response.status < 200 || response.status >= 300)
      return { ok: false, kind: "unavailable", reason: `HTTP ${response.status || "无响应"}` };
    if (!record(response.json) || response.json.jsonrpc !== "2.0" || response.json.id !== id)
      return { ok: false, kind: "unavailable", reason: "RPC 响应格式异常" };
    const hasResult = Object.hasOwn(response.json, "result");
    const hasError = Object.hasOwn(response.json, "error");
    if (hasResult === hasError)
      return { ok: false, kind: "unavailable", reason: "RPC 响应字段不完整" };
    if (hasResult) return { ok: true, value: response.json.result };

    const error = response.json.error;
    const code = record(error) ? error.code : undefined;
    const message = record(error) ? error.message : undefined;
    if (isExplicitRevert(code, message))
      return { ok: false, kind: "revert", reason: "合约调用被拒绝" };
    return { ok: false, kind: "unavailable", reason: `RPC 节点错误${typeof code === "number" ? ` ${code}` : ""}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: "unavailable", reason };
  }
}

function note(network: RpcNetwork, address: string, reason: string): void {
  console.warn(`[token-check] ${network.slug} ${address.slice(0, 10)}: ${reason}`);
}

/** Check that the address is a deployed contract implementing the basic ERC-20 read interface. */
async function inspectNetwork(
  network: RpcNetwork,
  address: string,
  rpcBase?: string,
): Promise<Erc20Verdict> {
  const endpoint = rpcBase ? `${rpcBase.replace(/\/+$/, "")}/${network.slug}` : network.endpoint;
  const [chainResponse, codeResponse] = await Promise.all([
    callRpc(endpoint, "eth_chainId", []),
    callRpc(endpoint, "eth_getCode", [address, "latest"]),
  ]);

  if (!chainResponse.ok) {
    note(network, address, `chainId 查询失败：${chainResponse.reason}`);
    return "unknown";
  }
  const observedChain = rpcQuantity(chainResponse.value);
  if (observedChain === undefined) {
    note(network, address, "chainId 返回格式异常");
    return "unknown";
  }
  if (observedChain !== network.chainId) {
    note(network, address, `RPC 链号不符：${observedChain}`);
    return "unknown";
  }

  if (!codeResponse.ok) {
    note(network, address, `合约代码查询失败：${codeResponse.reason}`);
    return "unknown";
  }
  if (typeof codeResponse.value !== "string" || !HEX_BYTES.test(codeResponse.value)) {
    note(network, address, "合约代码返回格式异常");
    return "unknown";
  }
  if (codeResponse.value === "0x") return "non-erc20";

  const checks = await Promise.all(TOKEN_READS.map(({ calldata }) =>
    callRpc(endpoint, "eth_call", [{ to: address, data: calldata }, "latest"]),
  ));
  let uncertain = false;
  for (let index = 0; index < checks.length; index++) {
    const check = checks[index];
    if (!check.ok) {
      if (check.kind === "revert") return "non-erc20";
      note(network, address, `${TOKEN_READS[index].name} 查询失败：${check.reason}`);
      uncertain = true;
      continue;
    }
    if (typeof check.value !== "string" || !HEX_BYTES.test(check.value)) {
      note(network, address, `${TOKEN_READS[index].name} 返回格式异常`);
      uncertain = true;
      continue;
    }
    if (!HEX_WORD.test(check.value)) return "non-erc20";
  }
  return uncertain ? "unknown" : "erc20";
}

export const Erc20 = {
  /** A hint changes probe order only; a positive result on any configured chain wins. */
  async check(address: string, chainHint: string | null = null, rpcBase?: string): Promise<Erc20Verdict> {
    if (typeof address !== "string" || !ADDRESS.test(address)) return "unknown";
    const preferred = chainHint === null
      ? undefined
      : NETWORKS.find((network) => network.slug === tokenChainKey(chainHint));
    if (chainHint !== null && !preferred) return "unknown";
    const queue = preferred
      ? [preferred, ...NETWORKS.filter((network) => network !== preferred)]
      : [...NETWORKS];
    let certainNegatives = 0;
    for (const network of queue) {
      const verdict = await inspectNetwork(network, address, rpcBase);
      if (verdict === "erc20") return verdict;
      if (verdict === "non-erc20") certainNegatives++;
    }
    return certainNegatives === NETWORKS.length ? "non-erc20" : "unknown";
  },

  /** Verify a candidate against one known RPC chain. Unknown chains remain unknown. */
  async checkChain(address: string, chain: string, rpcBase?: string): Promise<Erc20Verdict> {
    if (typeof address !== "string" || !ADDRESS.test(address)) return "unknown";
    const network = NETWORKS.find(({ slug }) => slug === tokenChainKey(chain));
    return network ? inspectNetwork(network, address, rpcBase) : "unknown";
  },
};

/**
 * Conservatively identify an EVM wallet by EIP-7702 delegation, outgoing
 * activity, or funded EOA evidence. Missing contract code alone is not enough.
 */
export async function auditEvmWalletAddress(address: string): Promise<EvmWalletAudit> {
  if (typeof address !== "string" || !ADDRESS.test(address))
    return { kind: "unknown", reason: "地址格式不符合 EVM", checkedNetworks: [] };

  const inspections = await Promise.all(NETWORKS.map(async (network) => {
    const [chainResponse, codeResponse] = await Promise.all([
      callRpc(network.endpoint, "eth_chainId", []),
      callRpc(network.endpoint, "eth_getCode", [address, "latest"]),
    ]);
    if (!chainResponse.ok || !codeResponse.ok)
      return { network, kind: "unknown" as const, reason: !chainResponse.ok ? chainResponse.reason : !codeResponse.ok ? codeResponse.reason : "RPC 查询失败" };
    const chainId = rpcQuantity(chainResponse.value);
    if (chainId !== network.chainId)
      return { network, kind: "unknown" as const, reason: chainId === undefined ? "链号响应无效" : `链号不符 ${chainId}` };
    if (typeof codeResponse.value !== "string" || !HEX_BYTES.test(codeResponse.value))
      return { network, kind: "unknown" as const, reason: "合约代码响应无效" };
    return { network, kind: codeResponse.value === "0x" ? "empty" as const : "contract" as const, code: codeResponse.value };
  }));
  const checkedNetworks = inspections.filter((item) => item.kind !== "unknown").map((item) => item.network.slug);
  const contracts = inspections.filter((item) => item.kind === "contract").map((item) => item.network.slug);
  const codeContracts = inspections.filter((item) => item.kind === "contract");
  const delegatedWallets = codeContracts.filter((item) => /^0xef0100[\da-f]{40}$/i.test(item.code));
  if (!inspections.some((item) => item.kind === "unknown") && codeContracts.length && delegatedWallets.length === codeContracts.length) {
    const item = delegatedWallets[0];
    const nonceResult = await callRpc(item.network.endpoint, "eth_getTransactionCount", [address, "latest"]);
    const nonce = nonceResult.ok ? rpcQuantity(nonceResult.value)?.toString() : undefined;
    return {
      kind: "wallet",
      network: item.network.slug,
      ...(nonce === undefined ? {} : { nonce }),
      checkedNetworks,
      evidence: { type: "eip7702", delegate: "0x" + item.code.slice(8) },
      reason: "检测到 EIP-7702 委托代码，确认是由 EOA 控制的钱包账户",
    };
  }
  if (contracts.length) return { kind: "contract", networks: contracts, checkedNetworks, reason: `在 ${contracts.join("、")} 发现合约代码，保留待核对` };
  const unavailable = inspections.find((item) => item.kind === "unknown");
  if (unavailable)
    return { kind: "unknown", reason: `${unavailable.network.slug} RPC 未能确认：${unavailable.reason}`, checkedNetworks };

  const nonces = await Promise.all(NETWORKS.map(async (network) => ({
    network,
    result: await callRpc(network.endpoint, "eth_getTransactionCount", [address, "latest"]),
  })));
  for (const { network, result } of nonces) {
    if (!result.ok) continue;
    const nonce = rpcQuantity(result.value);
    if (nonce !== undefined && nonce > 0n)
      return {
        kind: "wallet",
        network: network.slug,
        nonce: nonce.toString(),
        checkedNetworks,
        reason: "在该网络确认到地址主动发起的交易，且所查网络均无合约代码",
      };
  }
  const balances = await Promise.all(NETWORKS.map(async (network) => ({
    network,
    result: await callRpc(network.endpoint, "eth_getBalance", [address, "latest"]),
  })));
  for (const { network, result } of balances) {
    if (!result.ok) continue;
    const balance = rpcQuantity(result.value);
    if (balance !== undefined && balance > 0n) {
      return {
        kind: "wallet",
        network: network.slug,
        nonce: "0",
        checkedNetworks,
        evidence: { type: "funded-eoa", balanceWei: balance.toString() },
        reason: "所查网络均无合约代码，且地址持有原生币余额，按普通钱包地址归档",
      };
    }
  }
  const nonceFailure = nonces.find(({ result }) => {
    if (!result.ok) return true;
    return rpcQuantity(result.value) === undefined;
  });
  if (nonceFailure)
    return { kind: "unknown", reason: `${nonceFailure.network.slug} RPC 未能确认钱包交易记录`, checkedNetworks };
  const balanceFailure = balances.find(({ result }) => !result.ok || rpcQuantity(result.value) === undefined);
  if (balanceFailure)
    return { kind: "unknown", reason: `${balanceFailure.network.slug} RPC 未能确认原生币余额`, checkedNetworks };
  return { kind: "unknown", reason: "所查网络都没有该地址的发起交易记录，不能仅凭无合约代码判定为钱包", checkedNetworks };
}
