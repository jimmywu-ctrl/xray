import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import tls from "node:tls";

export interface Proxy {
  host: string;
  port: number;
}

export interface JsonResponse {
  status: number;
  json: unknown;
  text?: string;
  retryAfterMs?: number;
}

type ProxyCache = { storedAt: number; lookup: Promise<Proxy | null> };
type RequestOptions = {
  signal?: AbortSignal;
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
};

const WINDOWS_PROXY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const PROXY_CACHE_MS = 30_000;
const PROXY_CONNECT_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
let proxyCache: ProxyCache | null = null;
const tunnelAgents = new Map<string, https.Agent>();
const directAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000, timeout: 120_000 });

/** Resolve an explicit proxy first; on Windows, use the current user's WinINet setting as fallback. */
export function systemProxy(): Promise<Proxy | null> {
  if (proxyCache && Date.now() - proxyCache.storedAt < PROXY_CACHE_MS) return proxyCache.lookup;
  const lookup = detectProxy();
  proxyCache = { storedAt: Date.now(), lookup };
  return lookup;
}

export async function proxyAgent(): Promise<{ proxy: Proxy; agent: https.Agent } | undefined> {
  const proxy = await systemProxy();
  if (!proxy) return undefined;
  const key = `${proxy.host}:${proxy.port}`;
  let agent = tunnelAgents.get(key);
  if (!agent) {
    agent = new HttpsTunnelAgent(proxy);
    tunnelAgents.set(key, agent);
  }
  return { proxy, agent };
}

/** Public convenience API: a non-2xx response or invalid JSON is represented as null. */
export async function getJson(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<unknown> {
  const response = await requestJson(url, { timeoutMs, headers });
  return response.status >= 200 && response.status < 300 ? response.json : null;
}

/** HTTP/HTTPS JSON transport. The caller owns endpoint-specific status and payload validation. */
export async function requestJson(url: string, options: RequestOptions): Promise<JsonResponse> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`Unsupported request protocol: ${target.protocol}`);

  const secure = target.protocol === "https:";
  const transport = secure ? https : http;
  const agent = secure ? ((await proxyAgent())?.agent ?? directAgent) : undefined;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }

  return new Promise<JsonResponse>((resolve, reject) => {
    let settled = false;
    const finish = (value: JsonResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transport.request(target, {
      signal: options.signal,
      method: options.method ?? "GET",
      headers,
      agent,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const retryAfterMs = parseRetryAfter(header(response.headers["retry-after"]));
      const chunks: Buffer[] = [];
      let byteLength = 0;
      response.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += data.length;
        if (byteLength > RESPONSE_LIMIT_BYTES) {
          response.destroy(new Error("response body exceeds 16 MB"));
          finish({ status, json: null, retryAfterMs });
          return;
        }
        chunks.push(data);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { finish({ status, json: JSON.parse(text), retryAfterMs }); }
        catch { finish({ status, json: null, text, retryAfterMs }); }
      });
      response.on("error", fail);
    });

    const timeout = Math.max(1, Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000);
    const timer = setTimeout(() => request.destroy(new Error("request timed out")), timeout);
    request.on("error", fail);
    request.on("close", () => clearTimeout(timer));
    request.end(body);
  });
}

async function detectProxy(): Promise<Proxy | null> {
  for (const name of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    const value = process.env[name];
    if (!value) continue;
    const parsed = parseProxy(value);
    if (parsed) return parsed;
  }
  if (process.platform !== "win32") return null;

  const enabled = await queryRegistry("ProxyEnable");
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled)) return null;
  const configured = await queryRegistry("ProxyServer");
  const raw = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(configured)?.[1]?.trim();
  if (!raw) return null;
  const entries = raw.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? ["", part] as const : [part.slice(0, separator).toLowerCase(), part.slice(separator + 1)] as const;
  });
  const configuredServer = new Map(entries);
  const server = configuredServer.get("https") || configuredServer.get("http") || entries[0]?.[1];
  return server ? parseProxy(server) : null;
}

function queryRegistry(value: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("reg.exe", ["query", WINDOWS_PROXY_KEY, "/v", value], { encoding: "utf8" }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

function parseProxy(input: string): Proxy | null {
  try {
    const normalized = input.includes("://") ? input : `http://${input}`;
    const value = new URL(normalized);
    const port = Number(value.port) || (value.protocol === "https:" ? 443 : 80);
    return value.hostname ? { host: value.hostname, port } : null;
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

class HttpsTunnelAgent extends https.Agent {
  constructor(private readonly proxy: Proxy) {
    super({ keepAlive: true });
  }

  createConnection(
    options: https.RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): undefined {
    const done = callback;
    if (!done) throw new Error("HTTPS tunnel callback is required");
    let connected = false;
    const finish = (error: Error | null, stream: Duplex) => {
      if (connected) return;
      connected = true;
      done(error, stream);
    };
    const hostname = String(options.host ?? "");
    const port = Number(options.port ?? 443);
    const authority = `${hostname}:${port}`;
    const connect = http.request({
      host: this.proxy.host,
      port: this.proxy.port,
      method: "CONNECT",
      path: authority,
      headers: { Host: authority },
      timeout: PROXY_CONNECT_TIMEOUT_MS,
    });
    connect.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`proxy CONNECT returned HTTP ${response.statusCode}`), undefined as unknown as Duplex);
        return;
      }
      // Keep the TLS ClientHello compatible with the existing browser-backed provider route.
      finish(null, tls.connect({ socket, servername: hostname || undefined }));
    });
    connect.once("error", (error) => finish(error, undefined as unknown as Duplex));
    connect.once("timeout", () => connect.destroy(new Error("proxy CONNECT timed out")));
    connect.end();
    return undefined;
  }
}
