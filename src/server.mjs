import http from "node:http";
import {randomUUID} from 'node:crypto';
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { now, rank, RECENT_WINDOW_SEC } from "./domain/rules.mjs";
import { DashboardContract } from './services/dashboard-contract.mjs';
import { fetchAvatarImage } from './services/avatar-image.mjs';
import { correctCa } from './services/ca-correction.mjs';
const ui = fileURLToPath(new URL("./ui/", import.meta.url));
export function createServer({
  repo,
  ingestion,
  statistics,
  market,
  collectors,
  bridge,
  port = 48876,
  demo = false,
}) {
  const clients = new Set();
  let publishTimer;
  // Bumped on every change notification; /api/token-updates skips recomputation while nothing changed.
  let stateVersion = 0;
  const broadcast = ({ urgent = false, wake = false } = {}) => {
    stateVersion++;
    const publish = () => {
      publishTimer = null;
      for (const c of clients)
        c.write("data: " + JSON.stringify({ at: now(), urgent, wake }) + "\n\n");
    };
    if (urgent) {
      if (publishTimer) clearTimeout(publishTimer);
      publish();
      return;
    }
    if (publishTimer) return;
    publishTimer = setTimeout(publish, 25);
  };
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(data));
  };
  const dashboard = new DashboardContract(repo, collectors, market, bridge, broadcast);
  const tokenSnapshots=new Map();
  let tokenRevision=0;
  const tokenEpoch=randomUUID();
  let tokenSnapshotVersion=-1,tokenSnapshotAt=0,tokenSnapshotList=[];
  const TOKEN_SNAPSHOT_TTL_MS=2000;
  const server = http.createServer(async (req, res) => {
    try {
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host))
        return json(res, 403, { error: "仅允许本机访问" });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (
        req.headers.origin &&
        !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(
          req.headers.origin,
        )
      )
        return json(res, 403, { error: "来源不允许" });
      // Startup needs a listening/initialized server, not a multi-MB history export.
      if (req.method === 'GET' && url.pathname === '/api/ready')
        return json(res,200,{ok:true});
      if (req.method === 'GET' && url.pathname === '/api/avatar-image') {
        try {
          const image = await fetchAvatarImage(url.searchParams.get('src') || '');
          res.writeHead(200, {
            'Content-Type': image.contentType,
            'Content-Length': image.body.length,
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          });
          return res.end(image.body);
        } catch (error) {
          const status = Number(error.status) === 403 ? 403 : 502;
          res.writeHead(status, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          return res.end('头像来源暂时无法访问');
        }
      }
      let body = {};
      if (["POST", "PUT"].includes(req.method)) {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(res, 415, { error: "需要 JSON 请求" });
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 500000) return json(res, 413, { error: "请求过大" });
        }
        body = JSON.parse(raw || "{}");
      }
      if (req.method === "POST" && url.pathname === "/api/backfill/run")
        return json(res, 200, collectors.runBackfill(body.source, body.duration, body.resume === true));
      if (req.method === "POST" && url.pathname === "/api/debug/message-latency/received") {
        const entries = Array.isArray(body.entries) ? body.entries.slice(0, 500) : [];
        let updated = 0;
        repo.transaction(() => {
          for (const entry of entries) {
            if (typeof entry?.traceId !== "string" || entry.traceId.length > 2048 || !Number.isSafeInteger(entry.receivedAtMs) || entry.receivedAtMs > Date.now() + 60000) continue;
            const row = repo.get("SELECT id,detail FROM diagnostics WHERE category='message_latency' AND token=? ORDER BY id DESC LIMIT 1", entry.traceId);
            if (!row) continue;
            let detail; try { detail = JSON.parse(row.detail); } catch { continue; }
            if (detail.receivedAtMs != null || entry.receivedAtMs < Number(detail.ingestedAtMs)) continue;
            detail.receivedAtMs = entry.receivedAtMs;
            detail.detectedToReceivedMs = entry.receivedAtMs - Number(detail.detectedAtMs);
            detail.ingestToReceivedMs = entry.receivedAtMs - Number(detail.ingestedAtMs);
            if (detail.displayedAtMs != null) detail.receivedToDisplayMs = detail.displayedAtMs - entry.receivedAtMs;
            repo.run("UPDATE diagnostics SET detail=? WHERE id=?", JSON.stringify(detail), row.id);
            updated++;
          }
        });
        return json(res, 200, { ok: true, updated });
      }
      if (req.method === "POST" && url.pathname === "/api/debug/message-latency/rendered") {
        const displayedAtMs = Number(body.displayedAtMs);
        const traceIds = Array.isArray(body.traceIds) ? [...new Set(body.traceIds.filter((id) => typeof id === "string" && id.length <= 2048))].slice(0, 500) : [];
        if (!Number.isSafeInteger(displayedAtMs) || Math.abs(Date.now() - displayedAtMs) > 60_000) throw Error("卡片显示时间无效");
        let updated = 0;
        for (const traceId of traceIds) {
          const row = repo.get("SELECT id,detail FROM diagnostics WHERE category='message_latency' AND token=? ORDER BY id DESC LIMIT 1", traceId);
          if (!row) continue;
          let detail; try { detail = JSON.parse(row.detail); } catch { continue; }
          if (detail.displayedAtMs != null) continue;
          detail.displayedAtMs = displayedAtMs;
          detail.ingestToDisplayMs = displayedAtMs - Number(detail.ingestedAtMs);
          if (detail.receivedAtMs != null) detail.receivedToDisplayMs = displayedAtMs - detail.receivedAtMs;
          repo.run("UPDATE diagnostics SET detail=? WHERE id=?", JSON.stringify(detail), row.id);
          updated++;
        }
        return json(res, 200, { ok: true, updated });
      }
      if (req.method === "GET" && url.pathname === "/api/backfill/status")
        return json(res, 200, { bySource: collectors.backfillStatus ?? {} });
      if(req.method==='GET' && url.pathname==='/api/debug/performance')
        return json(res,200,repo.performanceSnapshot());
      if(req.method==='GET' && url.pathname==='/api/debug/memory') {
        const desktop=await bridge.rpc('desktop.memory',{},3000).catch(()=>null);
        return json(res,200,{at:Date.now(),pid:process.pid,backend:process.memoryUsage(),desktop});
      }
      if(req.method==='GET' && url.pathname==='/api/token-updates'){
        const since=Math.max(0,Number(url.searchParams.get('since'))||0);
        // Recompute after a change notification, or once the TTL passes so time-based fields (live, 12h window) still age.
        if(tokenSnapshotVersion!==stateVersion||Date.now()-tokenSnapshotAt>=TOKEN_SNAPSHOT_TTL_MS){
        const started=performance.now();
        const version=stateVersion,tokens=dashboard.tokens(),keys=new Set();
        for(const token of tokens){const key=token.key||token.chain+':'+token.address;keys.add(key);const old=tokenSnapshots.get(key);if(old?.token===token)continue;const payload=JSON.stringify(token);
          if(!old||old.payload!==payload)tokenSnapshots.set(key,{payload,token,revision:++tokenRevision});
          else old.token=token;
        }
        for(const [key,entry] of tokenSnapshots)if(!keys.has(key)&&entry.token)tokenSnapshots.set(key,{token:null,revision:++tokenRevision});
        tokenSnapshotVersion=version;tokenSnapshotAt=Date.now();tokenSnapshotList=tokens;
        repo.recordPerformance('token_snapshot',performance.now()-started,tokens.length);
        }
        const tokens=tokenSnapshotList;
        const changed=[],removed=[];
        for(const [key,entry] of tokenSnapshots)if(!since||entry.revision>since){if(entry.token)changed.push(entry.token);else removed.push(key);}
        // Bound tombstones; clients with older cursors receive a complete reset.
        const reset=url.searchParams.get('epoch')!==tokenEpoch||!since||since>tokenRevision||since<tokenRevision-10000;
        for(const [key,entry] of tokenSnapshots)if(!entry.token&&entry.revision<tokenRevision-10000)tokenSnapshots.delete(key);
        return json(res,200,{epoch:tokenEpoch,revision:tokenRevision,reset,changed:reset?tokens:changed,removed:reset?[]:removed});
      }
      const presented = await dashboard.handle(req, url, body);
      if (presented !== undefined) return json(res, 200, presented);
      if (url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("data: {}\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      // Overlay polls only what it renders (monitor groups + opacity); the dashboard keeps the full /api/state.
      if (req.method === "GET" && url.pathname === "/api/overlay-state")
        return json(res, 200, {
          monitor: collectors?.status() ?? {},
          settings: {
            monitor: repo.setting("monitor", { wechat: [], telegram: [] }),
            opacity: repo.setting("opacity", 1),
            refreshSeconds: 3,
          },
          time: now(),
        });
      if (req.method === "GET" && url.pathname === "/api/summary-state") {
        // The desktop dashboard modules only need these aggregate fields.
        // Keep full token details on /api/state for diagnostics and external callers.
        const rows = repo.projection("rows", []).map((r) => ({
          chain: r.chain,
          address: r.address,
          lastCall: r.lastCall,
          senderKey: r.senderKey,
          priceMultiple: r.priceMultiple,
          formalMultiple: r.formalMultiple,
        }));
        return json(res, 200, {
          version: "1.0.0",
          demo,
          rows,
          monitor: collectors?.status() ?? {
            wechat: { watched: 0 },
            telegram: { state: "needs_credentials" },
          },
          settings: {
            monitor: repo.setting("monitor", { wechat: [], telegram: [] }),
            opacity: repo.setting("opacity", 1),
          },
          jobs: repo.all("SELECT lane,state,COUNT(*) count FROM jobs GROUP BY lane,state"),
          time: now(),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const rows = repo.projection("rows", []);
        const filtered = rows.filter(
          (r) =>
            (!url.searchParams.get("source") ||
              r.source === url.searchParams.get("source")) &&
            (!url.searchParams.get("channel") ||
              r.channel === url.searchParams.get("channel")),
        );
        const overview = {
          total: filtered.length,
          formal: filtered.filter((r) => r.priceMultiple != null).length,
          reference: 0,
          pending: filtered.filter((r) => r.priceMultiple == null).length,
          wins: filtered.filter((r) => r.priceMultiple >= 2).length,
        };
        const acquisition = repo.get(`
          SELECT COUNT(*) total,
            SUM(CASE WHEN pr.peak IS NOT NULL THEN 1 ELSE 0 END) ready,
            SUM(CASE WHEN t.last_call>=? THEN 1 ELSE 0 END) active,
            SUM(CASE WHEN j.state='RUNNING' THEN 1 ELSE 0 END) running
          FROM claims c
          JOIN tokens t USING(chain,address)
          LEFT JOIN price_results pr ON pr.chain=c.chain AND pr.address=c.address AND pr.claim_version=c.version
          LEFT JOIN jobs j ON j.chain=c.chain AND j.address=c.address AND j.claim_version=c.version AND j.lane='capture'
          WHERE c.active=1
        `, now() - RECENT_WINDOW_SEC) ?? { total: 0, ready: 0, active: 0, running: 0 };
        const waitingQuiet = repo.get("SELECT COUNT(*) count FROM jobs WHERE lane='capture' AND state='QUEUED' AND due>? AND json_extract(payload,'$.stage')='history' AND COALESCE(json_extract(payload,'$.refresh'),0)=0 AND json_extract(payload,'$.manualBatchId') IS NULL", now())?.count ?? 0;
        return json(res, 200, {
          version: "1.0.0",
          demo,
          overview,
          acquisition: {
            total: acquisition.total ?? 0,
            ready: acquisition.ready ?? 0,
            active: acquisition.active ?? 0,
            running: acquisition.running ?? 0,
            waitingQuiet,
          },
          rows: filtered,
          leaderboard: rank(filtered),
          monitor: collectors?.status() ?? {
            wechat: { watched: 0 },
            telegram: { state: "needs_credentials" },
          },
          settings: {
            monitor: repo.setting("monitor", { wechat: [], telegram: [] }),
            opacity: repo.setting("opacity", 1),
            refreshSeconds: 3,
          },
          jobs: repo.all(
            "SELECT lane,state,COUNT(*) count FROM jobs GROUP BY lane,state",
          ),
          time: now(),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/groups")
        return json(
          res,
          200,
          await collectors.groups(url.searchParams.get("source")),
        );
      if (req.method === "GET" && url.pathname === "/api/logs") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="xray-next-diagnostics.json"',
        });
        res.end(
          JSON.stringify(
            {
              version: "1.0.0",
              at: now(),
              jobs: repo.all(
                "SELECT lane,chain,address,claim_version,state,attempts,due,last_error FROM jobs",
              ),
              diagnostics: repo.all(
                "SELECT * FROM diagnostics ORDER BY id DESC LIMIT 5000",
              ),
              results: repo
                .view()
                .map((r) => ({
                  chain: r.chain,
                  address: r.address,
                  status: r.status,
                  baseline: r.baseline,
                  formalPeak: r.formalPeak,
                  referencePeak: r.referencePeak,
                })),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (req.method === "POST") {
        if (url.pathname === '/api/ca-correction') {
          const result = correctCa(repo, ingestion, body);
          market.invalidateInventory?.();
          broadcast();
          return json(res, 200, result);
        }
        if (url.pathname === "/api/visible") {
          if (!Array.isArray(body.keys)) throw Error("可见代币格式无效");
          market.setVisible(body.keys);
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/api/settings") {
          if (
            body.opacity != null &&
            (!Number.isFinite(body.opacity) ||
              body.opacity < 0.3 ||
              body.opacity > 1)
          )
            throw Error("透明度须为 30% 至 100%");
          if (body.monitor) collectors.update(body.monitor);
          for (const k of ["opacity"])
            if (body[k] != null) repo.set(k, body[k]);
          repo.project();
          broadcast();
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/api/site") {
          if (body.provider !== "ave") throw Error("行情登录来源无效");
          await bridge.rpc("site.open", { provider: body.provider });
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/api/desktop") {
          if (!["overlay", "keys"].includes(body.action))
            throw Error("操作无效");
          return json(res, 200, await bridge.rpc("desktop.action", body));
        }
        if (url.pathname.startsWith("/api/telegram/"))
          return json(
            res,
            200,
            await collectors.action(url.pathname.split("/").at(-1), body),
          );
        if (url.pathname === "/api/ingest") {
          if (!demo && process.env.XRAY_ALLOW_INJECT !== "1")
            return json(res, 403, { error: "手动注入仅供隔离测试" });
          return json(res, 200, { result: ingestion.ingest(body) });
        }
        if (url.pathname === "/api/revoke") {
          statistics.revoke(Number(body.id), body.reason);
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/api/repair") {
          return json(res, 410, {
            error: "批量补查已关闭；数据库只在新喊单时处理对应代币",
          });
        }
      }
      if (req.method !== "GET") return json(res, 404, { error: "接口不存在" });
      const name =
        url.pathname === "/"
          ? "index.html"
          : url.pathname === "/overlay"
            ? "overlay.html"
            : decodeURIComponent(url.pathname.slice(1));
      const filename = path.resolve(ui, name);
      const relative = path.relative(ui, filename);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        !fs.existsSync(filename) ||
        !fs.statSync(filename).isFile()
      )
        return json(res, 404, { error: "文件不存在" });
      const type =
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
          ".webp": "image/webp",
          ".svg": "image/svg+xml",
        }[path.extname(filename)] ?? "application/octet-stream";
      const stat = fs.statSync(filename);
      const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
      const headers = {
        "Content-Type": type.startsWith("text/") ? type + "; charset=utf-8" : type,
        "Cache-Control": path.extname(filename) === ".html" ? "no-store" : "no-cache",
        ETag: etag,
        "Last-Modified": stat.mtime.toUTCString(),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
      };
      const ifNoneMatch = req.headers["if-none-match"];
      if (
        path.extname(filename) !== ".html" &&
        ifNoneMatch &&
        (ifNoneMatch === "*" ||
          ifNoneMatch.split(",").some((value) => value.trim() === etag))
      ) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, { ...headers, "Content-Length": stat.size });
      fs.createReadStream(filename).pipe(res);
    } catch (e) {
      repo.diagnostic("api", null, e.message);
      json(res, 400, { error: e.message });
    }
  });
  server.listen(port, "127.0.0.1");
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": heartbeat\n\n");
  }, 15000);
  server.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(publishTimer);
    for (const c of clients) c.end();
  });
  return { server, broadcast };
}
