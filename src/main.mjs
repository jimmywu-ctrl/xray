import path from "node:path";
import os from "node:os";
import fs from "node:fs";
// Adapters are loaded only after the independent storage path is fixed.
const data =
  process.env.XRAY_DATA_DIR ??
  path.join(process.env.APPDATA ?? os.homedir(), "xray-next");
process.env.XRAY_DATA_DIR = data;
process.env.FOMOMO_DATA_DIR = data;
fs.mkdirSync(data, { recursive: true });
const [
  { Repository },
  { IngestionService },
  { StatisticsService },
  { MarketService },
  { Worker },
  { Bridge },
  { Collectors },
  { createServer },
] = await Promise.all([
  import("./infra/database.mjs"),
  import("./services/ingestion.mjs"),
  import("./services/statistics.mjs"),
  import("./services/market.mjs"),
  import("./infra/worker.mjs"),
  import("./infra/bridge.mjs"),
  import("./services/collectors.mjs"),
  import("./server.mjs"),
]);
const repo = new Repository(path.join(data, "xray.sqlite"));
// Record the real on-disk location (junctions / packaged-app redirection resolved) next to the configured one.
let realData = data;
try { realData = fs.realpathSync.native(data); } catch {}
fs.writeFileSync(path.join(data, 'backend-runtime.json'), JSON.stringify({pid:process.pid,dataDirectory:realData,configuredDataDirectory:data,database:path.join(realData,'xray.sqlite'),monitorGroups:repo.setting('monitor',{wechat:[],telegram:[]}),entrypoint:import.meta.url,startedAt:Date.now()},null,2));
const bridge = new Bridge();
let web;
let market;
const changed = (options) => web?.broadcast(options);
const dataChanged = (options) => {
  market?.invalidateInventory();
  if (Array.isArray(options?.prefetchKeys) && options.prefetchKeys.length) {
    const knownChainKeys = options.prefetchKeys.filter((key) => !key.startsWith('?:'));
    if (knownChainKeys.length) void market?.refreshFastMetadata(knownChainKeys, { priority: 'new-call' });
    const unknownKeys = options.prefetchKeys.filter((key) => key.startsWith('?:'));
    const unknownAddresses = unknownKeys.map((key) => key.slice(2));
    if (unknownAddresses.length) {
      // Start display metadata and the existing AVE→Dex chain check before
      // worker scheduling; both are reused when the capture job reaches them.
      void market?.refreshFastMetadata(unknownKeys, { includeUnknown: true, priority: 'new-call' });
      market?.prefetchUnknownChains(unknownAddresses);
      void market?.auditNextUnknownWallet(unknownAddresses);
    }
  }
  changed(options);
};
const ingestion = new IngestionService(repo, dataChanged);
const statistics = new StatisticsService(repo, dataChanged);
market = new MarketService(repo, bridge, statistics, ingestion, changed);
const demo = process.env.XRAY_DEMO === "1";
let collectors = demo ? null : new Collectors(repo, ingestion, changed);
const worker = new Worker(repo, market.handlers(), {preferredTokens:()=>market.visible});
if (demo) {
  const { seedDemo } = await import("./ui/demo.mjs");
  seedDemo(repo, ingestion, statistics);
}
repo.projectNow();
repo.enableBackgroundProjection();
web = createServer({
  repo,
  bridge,
  ingestion,
  statistics,
  market,
  collectors,
  port: Number(process.env.XRAY_PORT ?? 48876),
  demo,
});
repo.onProjected = changed;
if (!demo) {
  market.start();
  worker.start();
  collectors.start().catch((e) => repo.diagnostic("startup", null, e.message));
}
console.error(
  `X-ray Next ${demo ? "DEMO" : "LIVE"} listening on ${process.env.XRAY_PORT ?? 48876}; independent data directory: ${data}`,
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  market.stop();
  worker.stop();
  await collectors?.stop();
  web.server.close(() => {
    repo.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("close", () => {
  if (!process.env.XRAY_HEADLESS) void shutdown();
});
