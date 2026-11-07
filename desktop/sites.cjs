// Protocol-only browser-session adapter. Credentials never leave Electron's site sessions.
const { BrowserWindow, session, app, safeStorage } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const { execFile } = require("node:child_process");
const { withRequestDeadline } = require('./request-deadline.cjs');
const { createIdleResource } = require('./idle-resource.cjs');

function aveSystemProxy() {
  if (process.platform !== "win32") return Promise.resolve({ mode: "system" });
  return new Promise(resolve => {
    execFile("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { windowsHide: true, timeout: 2000, encoding: "utf8" }, (error, output) => {
        if (!error && /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)) {
          const server = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
          if (server) return resolve({ mode: "fixed_servers", proxyRules: server, proxyBypassRules: "<local>" });
        }
        resolve({ mode: "system" });
      });
  });
}
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
    this.searchWindow = null;
    this.searchQueue = Promise.resolve();
    this.searchIdle = createIdleResource({retire:()=>{
      const w=this.searchWindow;
      if(!w||w.isDestroyed())return true;
      if(w.isVisible())return false;
      w.destroy();
      if(this.searchWindow===w)this.searchWindow=null;
      return true;
    }});
    this.aveTemplate = null;
    this.quitting = false;
    this.aveRestore = null;
    this.aveSaved = null;
    this.aveNetworkAt = 0;
    this.aveNetworkSignature = "";
    this.aveNetworkPending = null;
    this.aveOriginFailures = new Map();
    this.restoreAveTemplate();
  }
  async configureAveNetwork() {
    if (this.aveNetworkPending) return this.aveNetworkPending;
    if (Date.now() - this.aveNetworkAt < 30_000) return;
    this.aveNetworkPending = (async () => {
      const config = await aveSystemProxy();
      const signature = JSON.stringify(config);
      if (signature !== this.aveNetworkSignature) {
        const ses = session.fromPartition("persist:xray-next-ave");
        await ses.setProxy(config);
        await ses.closeAllConnections();
        this.aveNetworkSignature = signature;
        console.error(`[ave-network] session proxy mode=${config.mode}`);
      }
      this.aveNetworkAt = Date.now();
    })().finally(() => { this.aveNetworkPending = null; });
    return this.aveNetworkPending;
  }
  async fetchAveWithFallback(url, template, signal) {
    const ses = session.fromPartition("persist:xray-next-ave");
    const origins = [...new Set([url.origin, ...fallbackOrigins])]
      .filter(origin => (this.aveOriginFailures.get(origin) || 0) <= Date.now());
    if (!origins.length) throw Error("AVE network temporarily unavailable: 查询节点正在冷却");
    let lastError;
    for (const origin of origins.slice(0, 3)) {
      signal?.throwIfAborted();
      const target = new URL(url); target.host = new URL(origin).host;
      try {
        const res = await ses.fetch(target.href, {
          method: "GET", headers: template.headers, credentials: "include", cache: "no-store",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        });
        const body = (await res.text()).slice(0, 1500000);
        let payload; try { payload = JSON.parse(body); } catch {}
        if (res.status >= 500 || (res.status === 200 && !payload))
          throw Error(`AVE HTTP ${res.status} invalid JSON response`);
        this.aveOriginFailures.delete(origin);
        const nextTemplate = { ...template, url: origin + "/v2api/token_info/v1/token/detail" };
        if (Number(payload?.status) === 1 && res.status === 200) {
          this.aveTemplate = nextTemplate;
          this.saveAveTemplate(nextTemplate);
        }
        return { res, body, payload, template: nextTemplate, url: target };
      } catch (error) {
        signal?.throwIfAborted();
        this.aveOriginFailures.set(origin, Date.now() + 60_000);
        lastError = error;
      }
    }
    throw lastError || Error("AVE 查询节点暂时不可用");
  }
  templatePath() { return path.join(app.getPath("userData"), "ave-session-connection.bin"); }
  restoreAveTemplate() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return;
      const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(this.templatePath())));
      if (!allowed(value.url, "ave", true) || !/\/token\/detail$/.test(new URL(value.url).pathname) || value.method !== "GET") return;
      const headers = {};
      for (const [key, entry] of Object.entries(value.headers || {}))
        if (!/^(cookie|host|content-length|origin|referer|user-agent|accept-encoding|sec-)/i.test(key) && typeof entry === "string" && entry.length < 4096) headers[key] = entry;
      this.aveTemplate = {url:value.url,method:"GET",headers};
      this.aveSaved = JSON.stringify(this.aveTemplate);
    } catch {}
  }
  saveAveTemplate(template) {
    try {
      if (!safeStorage.isEncryptionAvailable()) return;
      const url = new URL(template.url); url.search = "";
      url.pathname = "/v2api/token_info/v1/token/detail";
      const value = JSON.stringify({url:url.href,method:"GET",headers:template.headers});
      if (value === this.aveSaved) return;
      const file = this.templatePath();
      fs.mkdirSync(path.dirname(file), {recursive:true});
      fs.writeFileSync(file+".tmp", safeStorage.encryptString(value));
      fs.renameSync(file+".tmp", file);
      this.aveSaved = value;
    } catch { console.error("[ave] 无法保存加密连接信息"); }
  }
  async readyAveTemplate(params) {
    if (!this.aveTemplate) this.restoreAveTemplate();
    if (this.aveTemplate) return this.aveTemplate;
    if (!this.aveRestore) this.aveRestore = (async () => {
      const wire = params.chain === "sol" ? "solana" : params.chain;
      const target = `https://ave.ai/token/${encodeURIComponent(params.address)}-${wire}`;
      const w = this.ensure("ave", target);
      // Reuse the site's existing login token inside Electron. No token is sent to the backend.
      try {
        await w.webContents.debugger.sendCommand("DOMStorage.enable");
        const {entries} = await w.webContents.debugger.sendCommand("DOMStorage.getDOMStorageItems", {
          storageId: {securityOrigin:"https://ave.ai",isLocalStorage:true},
        });
        const stored = new Map(entries);
        const token = stored.get("ave_token");
        let origin = fallbackOrigins[0];
        try { const selected=JSON.parse(stored.get("apiDomain1")||"null"); if (selected?.domain && allowed(selected.domain,"ave",true)) origin=new URL(selected.domain).origin; } catch {}
        if (typeof token === "string" && token.length > 0 && token.length < 4096) {
          this.aveTemplate = {url:origin+"/v2api/token_info/v1/token/detail",method:"GET",headers:{"X-Auth":token,"Ave-Platform":"web",lang:"cn"}};
          return this.aveTemplate;
        }
      } catch {}
      if (w.webContents.getURL() && new URL(w.webContents.getURL()).pathname === "/") {
        w.siteReady = w.loadURL(target).catch(()=>{});
      }
      await this.wait(w);
      for (let i=0; !this.aveTemplate && i<24; i++) await new Promise(resolve=>setTimeout(resolve,250));
      if (!this.aveTemplate) throw Error("AVE 内置页面接口尚未就绪，请检查登录和网络连接");
      return this.aveTemplate;
    })().finally(()=>{this.aveRestore=null;});
    return this.aveRestore;
  }
  ensure(provider, initialUrl) {
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
            `(()=>{let list;try{list=JSON.parse(localStorage.getItem('apiList1'));}catch{}if(!Array.isArray(list)||list.length!==${fallbackOrigins.length}||!list.every((v,i)=>v===${JSON.stringify(fallbackOrigins)}[i]))return false;localStorage.removeItem('apiList1');localStorage.removeItem('apiDomain1');return true;})()`,
          );
          if (changed) w.reload();
        } catch {}
      });
    }
    w.siteReady = w.loadURL(initialUrl || `https://${provider}.ai/`, {
      extraHeaders: "Cache-Control: no-cache\n",
    }).catch(() => {});
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
            else if (!this.aveTemplate && /^\/(?:v1api|v2api)\//i.test(url.pathname)) {
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
    if (w.siteReady) await Promise.race([w.siteReady, new Promise(resolve => setTimeout(resolve, 12000))]);
    if (w.webContents.isLoading())
      await Promise.race([
        new Promise((resolve) =>
          w.webContents.once("did-finish-load", resolve),
        ),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
  }
  async aveQuery(p, signal) {
    signal?.throwIfAborted();
    await this.configureAveNetwork();
    const chain = p.chain === "solana" ? "sol" : p.chain;
    if (
      !supportedChain(chain) ||
      !(chain === "sol"
        ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.address)
        : /^0x[\da-f]{40}$/i.test(p.address))
    )
      throw Error("所属链或合约格式无效");
    const template = await this.readyAveTemplate({chain,address:p.address});
    signal?.throwIfAborted();
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
    const fetched = await this.fetchAveWithFallback(u, template, signal);
    const { res, body, payload } = fetched;
    if (res.status === 200 && Number(payload?.status) === 1) {
      this.saveAveTemplate(fetched.template);
      const loginWindow = this.windows.get("ave");
      if (this.aveSaved && loginWindow && !loginWindow.isDestroyed() && !loginWindow.isVisible()) {
        loginWindow.destroy(); this.windows.delete("ave");
      }
    }
    // Expired authorization is distinct from rate limits and temporary gateway errors.
    if (res.status === 401 || Number(payload?.status) === 10001) {
      this.aveTemplate = null; this.aveSaved = null;
      try { fs.unlinkSync(this.templatePath()); } catch {}
      const window = this.windows.get("ave");
      if (window && !window.isDestroyed()) window.reload();
      else this.ensure("ave");
      throw Error("AVE 登录连接已过期，正在恢复登录会话");
    }
    return {
      chain,
      address: p.address,
      status: res.status,
      body,
      endpoint: fetched.url.origin + fetched.url.pathname,
    };
  }
  async aveSearchAddress(p, signal) {
    await this.configureAveNetwork();
    const address = String(p?.address || "");
    if (!/^0x[\da-f]{40}$/i.test(address) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
      throw Error("合约地址格式无效");
    signal?.throwIfAborted();
    const search = async () => {
      if(this.quitting)throw Error('桌面正在退出');
      signal?.throwIfAborted();
      const w = this.ensureAveSearch();
      let readyTimer;
      try{await Promise.race([w.siteReady,new Promise(resolve=>{readyTimer=setTimeout(resolve,12000);})]);}
      finally{clearTimeout(readyTimer);}
      signal?.throwIfAborted();
      const addressJson = JSON.stringify(address);
      const waitForVisibleInput = () => w.webContents.executeJavaScript(`(async()=>{const isSearch=el=>/搜索|search|地址|合约|代币|钱包|CA/i.test(el.placeholder||'')||el.type==='search';const visible=()=>[...document.querySelectorAll('input')].some(el=>isSearch(el)&&(()=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return el.getClientRects().length&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'})());for(let i=0;i<20;i++){if(visible())return true;await new Promise(r=>setTimeout(r,250));}return false;})()`);
      let inputReady = await waitForVisibleInput();
      const debuggerApi = w.webContents.debugger;
      let attached = false;
      try {
        if (!debuggerApi.isAttached()) {
          debuggerApi.attach("1.3");
          attached = true;
        }
        await debuggerApi.sendCommand("DOM.enable");
        await debuggerApi.sendCommand("Runtime.enable");
        // Query by root handle; serializing every descendant is unnecessary.
        let { root } = await debuggerApi.sendCommand("DOM.getDocument", { depth: 0, pierce: true });
        if (!inputReady) {
          const { nodeIds: anchors } = await debuggerApi.sendCommand("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "header a.clickable" });
          let clicked = false;
          for (const anchorId of anchors || []) {
            const { outerHTML } = await debuggerApi.sendCommand("DOM.getOuterHTML", { nodeId: anchorId });
            if (!outerHTML?.includes("搜索代币名称/合约/钱包地址")) continue;
            const { model: anchorModel } = await debuggerApi.sendCommand("DOM.getBoxModel", { nodeId: anchorId });
            const quad = anchorModel?.content || anchorModel?.border;
            if (!quad || quad.length < 8) continue;
            const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
            const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
            await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
            await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
            await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
            clicked = true;
            break;
          }
          if (!clicked) throw Error("AVE 页面搜索入口未找到");
          inputReady = await waitForVisibleInput();
          if (!inputReady) throw Error("点击 AVE 搜索入口后仍未出现可见输入框");
          ({ root } = await debuggerApi.sendCommand("DOM.getDocument", { depth: 0, pierce: true }));
        }
        const selector = "input";
        const { nodeIds } = await debuggerApi.sendCommand("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
        if (!nodeIds?.length) {
          const page = await debuggerApi.sendCommand("Runtime.evaluate", { expression: '({url:location.href,inputCount:document.querySelectorAll("input").length,hasSearch:!!document.querySelector("input[placeholder=\\\"搜索CA/地址\\\"]")})', returnByValue: true });
          throw Error(`AVE 页面未找到搜索框: ${JSON.stringify({ root: root.nodeName, children: root.childNodeCount, page: page.result?.value || null })}`);
        }
        let nodeId;
        for (const candidateId of nodeIds) {
          try {
            const { node } = await debuggerApi.sendCommand("DOM.describeNode", { nodeId: candidateId });
            const attributes = node?.attributes || [];
            let placeholder = "", type = "";
            for (let i = 0; i < attributes.length; i += 2) {
              if (attributes[i] === "placeholder") placeholder = attributes[i + 1];
              if (attributes[i] === "type") type = attributes[i + 1];
            }
            if (!/搜索|search|地址|合约|代币|钱包|CA/i.test(placeholder) && type !== "search") continue;
            await debuggerApi.sendCommand("DOM.focus", { nodeId: candidateId });
            nodeId = candidateId;
            break;
          } catch {}
        }
        if (!nodeId) throw Error("AVE 没找到可见的合约/地址搜索框");
        await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", modifiers: 2, windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
        await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
        await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
        await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
        await debuggerApi.sendCommand("Input.insertText", { text: address });
        await new Promise((resolve) => setTimeout(resolve, 250));
        await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        throw Error(`AVE 内置网页输入失败: ${error?.message || error}`);
      } finally {
        if (attached && debuggerApi.isAttached()) debuggerApi.detach();
      }
      return await w.webContents.executeJavaScript(`(async()=>{
        const address=${addressJson}, evm=address.startsWith('0x');
        const cmp=value=>evm?String(value||'').toLowerCase():String(value||'');
        const equal=(a,b)=>cmp(a)===cmp(b);
        const hasExact=value=>String(value||'').split(/[^a-z0-9]+/i).some(part=>equal(part,address));
        const shortPattern=new RegExp(address.slice(0,4)+'(?:\\\\s*\\\\.{2,}\\\\s*|\\\\s*…\\\\s*|\\\\s*⋯\\\\s*).{0,8}'+address.slice(-4),'i');
        const aliases={ethereum:'eth',eth:'eth',solana:'sol',sol:'sol',bsc:'bsc',bnb:'bsc','bnb chain':'bsc',binance:'bsc','binance-smart-chain':'bsc','bnb-smart-chain':'bsc',arb:'arbitrum',op:'optimism'};
        const slug=value=>{
          const raw=String(value||'').trim().toLowerCase().replace(/^chain[:_-]?/,'');
          const direct=aliases[raw];
          if(direct)return direct;
          const numeric={1:'eth',56:'bsc',8453:'base',42161:'arbitrum',10:'optimism',137:'polygon',101:'sol',501:'sol'}[raw];
          if(numeric)return numeric;
          if(/^[a-z0-9][a-z0-9_-]{0,31}$/.test(raw)&&!/^\\d+$/.test(raw))return raw;
          return '';
        };
        const chainLabel=value=>{
          const raw=String(value||'').toLowerCase().replace(/\\b(chain|network|blockchain|mainnet)\\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim();
          if(aliases[raw])return aliases[raw];
          const compact=raw.replace(/\\s+/g,'');
          for(const [label,route] of Object.entries(aliases))if(label.replace(/[^a-z0-9]/g,'')===compact)return route;
          return '';
        };
        const chainFromUrl=raw=>{
          try{
            const u=new URL(raw,location.href),segments=decodeURIComponent(u.pathname).split('/').filter(Boolean);
            for(const [key,value] of u.searchParams){if(/^(chain|network|chainname|chainid)$/i.test(key)){const c=slug(value)||chainLabel(value);if(c)return c;}}
            for(let i=0;i<segments.length;i++){
              const part=segments[i];
              if(equal(part,address)){
                const prev=segments[i-1]||'',next=segments[i+1]||'';
                const before=slug(prev)||chainLabel(prev),after=slug(next)||chainLabel(next);
                if(before&&prev.toLowerCase()!=='token')return before;
                if(after)return after;
              }
              if(equal(part.slice(0,address.length),address)&&part.charAt(address.length)==='-')return slug(part.slice(address.length+1))||chainLabel(part.slice(address.length+1));
              if(part.charAt(part.length-address.length-1)==='-'&&equal(part.slice(-address.length),address))return slug(part.slice(0,-address.length-1))||chainLabel(part.slice(0,-address.length-1));
            }
          }catch{}
          return '';
        };
        const read=()=>{
          const found=new Map(),selector='*';
          for(const el of document.querySelectorAll(selector)){
            if(!el.getClientRects().length||/^(INPUT|TEXTAREA|SCRIPT|STYLE|SVG|PATH)$/.test(el.tagName))continue;
            let node=el,values=[],chainValues=[],hrefs=[],depth=0;
            const directText=[...el.childNodes].filter(child=>child.nodeType===Node.TEXT_NODE).map(child=>child.textContent||'').join(' ').trim();
            const isControl=/^(A|BUTTON|TR|LI)$/.test(el.tagName)||el.getAttribute('role')==='row'||el.getAttribute('role')==='link';
            const ownText=String(el.textContent||'').trim(),localMatch=ownText.length<600&&(hasExact(ownText)||shortPattern.test(ownText));
            if(!directText&&!isControl&&!el.matches('[data-address],[data-contract],[data-ca],[data-chain]')&&!localMatch)continue;
            if(directText)values.push(directText);
            while(node&&depth<5&&node!==document.body){
              const text=String(node.innerText||node.textContent||'').trim();
              if(text.length<700)values.push(text);
              for(const attr of [...(node.attributes||[])]){
                values.push(attr.value);
                if(attr.name==='href')hrefs.push(attr.value);
                if(/chain|network/i.test(attr.name))chainValues.push(slug(attr.value)||chainLabel(attr.value));
                else if(/^(title|aria-label|alt)$/i.test(attr.name))chainValues.push(chainLabel(attr.value));
              }
              for(const child of depth<3?(node.querySelectorAll?.('img[alt],img[title],[title],[aria-label],[data-chain],[data-network]')||[]):[]){
                for(const attr of [...child.attributes]){
                  values.push(attr.value);
                  if(/chain|network/i.test(attr.name))chainValues.push(slug(attr.value)||chainLabel(attr.value));
                  else if(/^(title|aria-label|alt)$/i.test(attr.name))chainValues.push(chainLabel(attr.value));
                }
              }
              node=node.parentElement;depth++;
            }
            const exact=values.some(hasExact)||hrefs.some(hasExact);
            const truncated=values.some(value=>shortPattern.test(String(value||'')));
            if(!exact&&!truncated)continue;
            const tokenHrefs=[...new Set(hrefs.filter(href=>/\\/token\\//i.test(href)&&(hasExact(href)||shortPattern.test(href))))];
            const chains=new Set();
            for(const href of tokenHrefs){const c=chainFromUrl(href);if(c)chains.add(c);}
            if(!tokenHrefs.length)for(const value of chainValues){if(value)chains.add(value);}
            const key=(exact?'exact:':'short:')+[...chains].sort().join(',')+':'+String(values.find(v=>shortPattern.test(String(v||'')))||'').slice(0,80);
            found.set(key,{exact,truncated,chains:[...chains],hrefs:tokenHrefs.slice(0,4),snippets:values.filter(value=>hasExact(value)||shortPattern.test(String(value||''))).slice(0,3).map(value=>String(value).slice(0,180))});
          }
          const candidates=[...found.values()];
          const exactCandidates=candidates.filter(item=>item.exact),chainCandidates=exactCandidates.length?exactCandidates:candidates;
          return {found:candidates.length>0,exact:exactCandidates.length>0,truncated:candidates.some(item=>item.truncated),chains:[...new Set(chainCandidates.flatMap(item=>item.chains))],candidateCount:candidates.length,candidateDetails:candidates.slice(0,16)};
        };
        let result=read();
        for(let i=0;i<48&&(!result.exact||!result.chains.length);i++){
          await new Promise(r=>setTimeout(r,250));result=read();
        }
        if(!result.found||!result.chains.length){
          const body=String(document.body?.innerText||''),textHits=[];
          for(const el of document.querySelectorAll('body *')){
            if(!el.getClientRects().length)continue;
            const text=String(el.innerText||'').trim();
            if(text.length>0&&text.length<240&&(hasExact(text)||shortPattern.test(text))){textHits.push(text.slice(0,180));if(textHits.length>=6)break;}
          }
          const tokenLinks=[...document.querySelectorAll('a[href]')].map(a=>({href:a.href,text:String(a.innerText||'').trim().slice(0,100)})).filter(item=>hasExact(item.href)||shortPattern.test(item.href)||shortPattern.test(item.text)||/\\/token\\//i.test(item.href)).slice(0,8);
          const searchInput=[...document.querySelectorAll('input')].find(el=>equal(el.value,address))||[...document.querySelectorAll('input')].find(el=>/搜索CA\\/地址/i.test(el.placeholder||''));
          const visiblePopups=[...document.querySelectorAll('[role="listbox"],[role="menu"],.el-popper,.el-autocomplete-suggestion,.search-result,.search-list')].filter(el=>el.getClientRects().length).slice(0,8).map(el=>({role:el.getAttribute('role')||'',className:typeof el.className==='string'?el.className:'',text:String(el.innerText||'').trim().slice(0,360),html:el.outerHTML?.slice(0,700)||''}));
          const controls=[...document.querySelectorAll('body *')].filter(el=>el.getClientRects().length&&/^(all|全部|币种|代币|bsc|solana|ethereum|base)$/i.test(String(el.innerText||'').trim())&&String(el.innerText||'').trim().length<=12).slice(0,24).map(el=>({tag:el.tagName,text:String(el.innerText||'').trim(),className:typeof el.className==='string'?el.className:'',role:el.getAttribute('role')||'',selected:el.getAttribute('aria-selected'),parent:el.parentElement?.outerHTML?.slice(0,420)||''}));
          result.diagnostic={url:location.href,title:document.title,bodyHasPrefix:body.toLowerCase().includes(address.slice(0,4).toLowerCase()),bodyHasSuffix:body.toLowerCase().includes(address.slice(-4).toLowerCase()),bodyHasExact:hasExact(body),bodyHasTruncated:shortPattern.test(body),inputCount:document.querySelectorAll('input').length,inputs:[...document.querySelectorAll('input')].slice(0,8).map(el=>({placeholder:el.placeholder||'',valueMatchesAddress:equal(el.value,address),value:String(el.value||'').slice(0,64),valueLength:String(el.value||'').length,focused:document.activeElement===el,ariaExpanded:el.getAttribute('aria-expanded')||''})),searchParent:searchInput?.parentElement?.outerHTML?.slice(0,1200)||'',visiblePopups,controls,textHits,tokenLinks};
        }
        return result;
      })()`);
    };
    // Keep the lease until the underlying operation settles, even if its caller
    // times out first. Pending queue entries protect the same warm window.
    const release=this.searchIdle.acquire();
    const task = this.searchQueue.then(search, search).finally(release);
    this.searchQueue = task.catch(() => {});
    const result = await withRequestDeadline(task, { signal });
    return {
      chains: [...new Set((result?.chains || []).map((chain) => String(chain).toLowerCase()))],
      tokenFound: Boolean(result?.found),
      exactAddress: Boolean(result?.exact),
      truncatedAddress: Boolean(result?.truncated),
      candidateCount: Number(result?.candidateCount || 0),
      candidateDetails: result?.candidateDetails || [],
      diagnostic: result?.diagnostic || null,
    };
  }
  ensureAveSearch() {
    if (this.searchWindow && !this.searchWindow.isDestroyed()) return this.searchWindow;
    const partition = "persist:xray-next-ave";
    const ses = session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    const w = new BrowserWindow({
      width: 1120, height: 780, show: false, title: "AVE address search",
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false },
    });
    w.on("closed", () => { if (this.searchWindow === w) this.searchWindow = null; });
    w.webContents.on("will-navigate", (e, url) => { if (!allowed(url, "ave") && !auth(url)) e.preventDefault(); });
    w.webContents.setWindowOpenHandler(({ url }) => ({ action: allowed(url, "ave") || auth(url) ? "allow" : "deny" }));
    this.searchWindow = w;
    w.siteReady = w.loadURL("https://ave.ai/", { extraHeaders: "Cache-Control: no-cache\n" }).catch(() => {});
    return w;
  }
  close() {
    this.quitting = true;
    this.searchIdle.stop();
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
    if (this.searchWindow && !this.searchWindow.isDestroyed()) this.searchWindow.destroy();
  }
}
module.exports = { SiteSessions };







