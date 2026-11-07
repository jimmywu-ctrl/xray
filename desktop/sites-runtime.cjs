// Protocol-only browser-session adapter. Credentials never leave Electron's site sessions.
const { BrowserWindow, session } = require("electron");
const supportedChain = (value) => value === "sol" || /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value);
const fallbackOrigins = [
  "https://yiyulu.com",
  "https://ccwlsc.com",
  "https://ft367.com",
  "https://hbhuixinkx.com",
  "https://gj99z.com",
  "https://primpom.com",
];
function allowed(raw, provider, api = false) {
  try {
    const u = new URL(raw),
      h = u.hostname;
    return (
      u.protocol === "https:" &&
      (h === `${provider}.ai` ||
        h.endsWith(`.${provider}.ai`) ||
        (provider === "ave" &&
          api &&
          (h === "ave-api.com" ||
            h.endsWith(".ave-api.com") ||
            fallbackOrigins.includes(u.origin))))
    );
  } catch {
    return false;
  }
}
function auth(raw) {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      [
        "accounts.google.com",
        "appleid.apple.com",
        "challenges.cloudflare.com",
      ].includes(u.hostname)
    );
  } catch {
    return false;
  }
}
class SiteSessions {
  constructor() {
    this.windows = new Map();
    this.aveTemplate = null;
    this.quitting = false;
  }
  ensure(provider) {
    let w = this.windows.get(provider);
    if (w && !w.isDestroyed()) return w;
    const partition = `persist:xray-next-${provider}`;
    const ses = session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    w = new BrowserWindow({
      width: 1120,
      height: 780,
      show: false,
      title: `${provider.toUpperCase()} · X-ray Next 登录`,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    this.windows.set(provider, w);
    w.on("close", (e) => {
      if (!this.quitting) {
        e.preventDefault();
        w.hide();
      }
    });
    const protect = (wc) => {
      wc.on("will-navigate", (e, url) => {
        if (!allowed(url, provider) && !auth(url)) e.preventDefault();
      });
      wc.setWindowOpenHandler(({ url }) => ({
        action: allowed(url, provider) || auth(url) ? "allow" : "deny",
      }));
      wc.on("did-create-window", (child) => protect(child.webContents));
    };
    protect(w.webContents);
    if (provider === "ave") {
      this.captureAve(w);
      let seeded = false;
      w.webContents.on("did-finish-load", async () => {
        if (seeded || !allowed(w.webContents.getURL(), "ave")) return;
        seeded = true;
        try {
          const changed = await w.webContents.executeJavaScript(
            `(()=>{const origins=${JSON.stringify(fallbackOrigins)};let selected;try{selected=JSON.parse(localStorage.getItem('apiDomain1'));}catch{}if(selected?.domain&&selected.domain!=='https://cyjm22.com')return false;localStorage.setItem('apiList1',JSON.stringify(origins));localStorage.setItem('apiDomain1',JSON.stringify({domain:origins[0],time:Date.now()}));return true;})()`,
          );
          if (changed) w.reload();
        } catch {}
      });
    }
    w.loadURL(`https://${provider}.ai/`);
    return w;
  }
  open(provider) {
    if (provider !== "ave") throw Error("登录来源无效");
    const w = this.ensure(provider);
    w.show();
    w.focus();
    return { ok: true };
  }
  captureAve(w) {
    const dbg = w.webContents.debugger,
      pending = new Map();
    try {
      dbg.attach("1.3");
      dbg.on("message", (_e, method, p) => {
        if (
          method === "Network.requestWillBeSent" &&
          allowed(p.request?.url, "ave", true)
        ) {
          const headers = {};
          for (const [k, v] of Object.entries(p.request.headers ?? {})) {
            if (
              /^(cookie|host|content-length|origin|referer|user-agent|accept-encoding|sec-)/i.test(
                k,
              )
            )
              continue;
            if (typeof v === "string" && v.length < 4096) headers[k] = v;
          }
          pending.set(p.requestId, {
            url: p.request.url,
            headers,
            method: p.request.method,
          });
          while (pending.size > 200)
            pending.delete(pending.keys().next().value);
        }
        if (method === "Network.responseReceived") {
          const r = p.response,
            template = pending.get(p.requestId);
          if (
            template &&
            r.status === 200 &&
            template.method === "GET" &&
            allowed(r.url, "ave", true)
          ) {
            const url = new URL(template.url);
            if (/\/token\/detail(?:\/|$)/i.test(url.pathname))
              this.aveTemplate = template;
            else if (
              /ave.*token|authorization|access[-_]?token/i.test(
                Object.keys(template.headers).join(" "),
              )
            ) {
              url.pathname = "/v2api/token_info/v1/token/detail";
              url.search = "?token_id=probe-base&cache_use=false";
              this.aveTemplate = { ...template, url: url.href };
            }
          }
        }
        if (
          method === "Network.loadingFinished" ||
          method === "Network.loadingFailed"
        )
          pending.delete(p.requestId);
      });
      void dbg.sendCommand("Network.enable");
    } catch {}
  }
  async wait(w) {
    if (w.webContents.isLoading())
      await Promise.race([
        new Promise((resolve) =>
          w.webContents.once("did-finish-load", resolve),
        ),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
  }
  async aveQuery(p) {
    const chain = p.chain === "solana" ? "sol" : p.chain;
    if (
      !supportedChain(chain) ||
      !(chain === "sol"
        ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.address)
        : /^0x[\da-f]{40}$/i.test(p.address))
    )
      throw Error("所属链或合约格式无效");
    const w = this.ensure("ave");
    await this.wait(w);
    const template = this.aveTemplate;
    if (!template)
      throw Error("请在 AVE 内置登录窗口搜索一次代币，建立接口连接");
    const u = new URL(template.url);
    if (!allowed(u.href, "ave", true)) throw Error("接口来源不允许");
    const wire = chain === "sol" ? "solana" : chain;
    if (p.mode === "kline") {
      if (
        ![1, 5, 15, 30, 60, 300, 900, 1800, 3600, 86400].includes(
          Number(p.interval),
        ) ||
        !Number.isInteger(p.from) ||
        !Number.isInteger(p.to) ||
        p.from <= 0 ||
        p.to <= p.from
      )
        throw Error("K 线参数无效");
      u.pathname = "/v2api/token_info/v1/token/kline_v2";
      u.search = "";
      for (const [k, v] of Object.entries({
        token: p.address,
        chain: wire,
        interval: p.interval,
        from: p.from,
        to: p.to,
        category: "u",
        limit_count: 300,
      }))
        u.searchParams.set(k, String(v));
    } else {
      u.searchParams.set("token_id", `${p.address}-${wire}`);
      u.searchParams.set("cache_use", "false");
    }
    const res = await w.webContents.session.fetch(u.href, {
      method: "GET",
      headers: template.headers,
      credentials: "include",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    return {
      chain,
      address: p.address,
      status: res.status,
      body: (await res.text()).slice(0, 1500000),
      endpoint: u.origin + u.pathname,
    };
  }
  close() {
    this.quitting = true;
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
  }
}
module.exports = { SiteSessions };
