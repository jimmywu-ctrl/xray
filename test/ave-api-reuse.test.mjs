import test from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/infra/database.mjs";
import { IngestionService } from "../src/services/ingestion.mjs";
import { MarketService } from "../src/services/market.mjs";
import { DashboardContract } from "../src/services/dashboard-contract.mjs";
import { PriceAcquisition } from "../src/services/price-acquisition.mjs";
import { isAveChainSlug } from "../src/domain/provider-chains.mjs";
import { now } from "../src/domain/rules.mjs";

const ADDRESS = "0x1111111111111111111111111111111111111111";

test("AVE page resolves chain once; repeated address uses saved chain", async () => {
  const repo = new Repository(":memory:");
  try {
    const ingestion = new IngestionService(repo);
    const market = new MarketService(repo, null, null, ingestion);
    ingestion.ingest({ source: "telegram", channel: "tg:1", message: "first", at: now() - 5, addresses: [ADDRESS], sender: "s" });
    market.prioritizeUnknownWalletAudit=()=>{};
    let pageCalls = 0;
    market.chainProbes = {
      avePageSearch: async () => { pageCalls++; return ["bsc"]; },
      dex: async () => { throw new Error("chain lookup must not call DEX"); },
    };
    const result = await market.resolveUnknownChain(ADDRESS);
    assert.equal(result.chain, "bsc");
    assert.equal(result.via, "ave_web");
    ingestion.resolveChain(ADDRESS, result.chain);
    const metadata = JSON.parse(repo.get("SELECT metadata FROM tokens WHERE chain='bsc' AND address=?", ADDRESS).metadata);
    assert.equal(metadata.aveChainLookup.status, "found");
    assert.equal(metadata.name, undefined, "the chain-only API must not fill token metadata");

    ingestion.ingest({ source: "telegram", channel: "tg:1", message: "second", at: now(), addresses: [ADDRESS], sender: "s" });
    const repeated = await market.resolveUnknownChain(ADDRESS);
    assert.equal(repeated.chain, "bsc");
    assert.equal(repeated.via, "cached_identity");
    assert.equal(pageCalls, 1);
  } finally {
    repo.close();
  }
});

test("historical acquisition uses the built-in AVE session", () => {
  const acquisition = new PriceAcquisition({ repo: {} });
  assert.deepEqual(acquisition.providers(), ["ave"]);
  assert.equal(isAveChainSlug("hyperevm"), true, "AVE-returned EVM chains beyond the picker list are routable");
  assert.equal(isAveChainSlug("../invalid"), false, "chain slugs cannot alter request routes");
});

test("AVE page miss checks Dex, and settled misses are not repeated", async () => {
  const repo = new Repository(":memory:");
  try {
    const ingestion = new IngestionService(repo);
    const market = new MarketService(repo, null, null, ingestion);
    ingestion.ingest({ source: "telegram", channel: "tg:1", message: "first", at: now() - 5, addresses: [ADDRESS], sender: "s" });
    market.prioritizeUnknownWalletAudit=()=>{};
    let pageCalls = 0;
    let dexCalls = 0;
    market.chainProbes = {
      avePageSearch: async () => { pageCalls++; return []; },
      dex: async () => { dexCalls++; return []; },
    };
    const first = await market.resolveUnknownChain(ADDRESS);
    const repeated = await market.resolveUnknownChain(ADDRESS);
    assert.equal(first.review, true);
    assert.equal(first.lookup.status, "no_match");
    assert.equal(repeated.review, true);
    assert.equal(pageCalls, 1);
    assert.equal(dexCalls, 1);
    const token = repo.get("SELECT metadata FROM tokens WHERE chain='?' AND address=?", ADDRESS);
    assert.equal(JSON.parse(token.metadata).aveChainLookup.status, "no_match");
    assert.equal(repo.get("SELECT COUNT(*) n FROM mentions WHERE chain='?' AND address=? AND active=1", ADDRESS).n, 1);
    repo.run("UPDATE jobs SET state='PARKED',wait='manual_review',last_error=? WHERE chain='?' AND address=?", "AVE 未查到；留待人工核对", ADDRESS);
    const dashboard = new DashboardContract(repo, {}, market, {}, () => {});
    const candidates = await dashboard.handle({ method: "GET" }, new URL("http://127.0.0.1/api/address-candidates"), {});
    assert.equal(candidates[0].status, "自动钱包复核排队中");
    assert.match(candidates[0].reason, /留待人工核对/);
  } finally {
    repo.close();
  }
});

test("failed overlay image is retained until a healthy AVE or DEX image replaces it", () => {
  const badLogo = "https://old.example/external-res/old.webp";
  const newLogo = "https://www.iconaves.com/token_icon/eth/new.webp";
  const token = { chain: "eth", address: ADDRESS, version: 1, verified: true, logo: badLogo, quote: { logo: badLogo } };
  let metadata = { logo: badLogo, sources: { logo: { provider: "old-cache", at: now() } } };
  const repo = {
    projection: () => [token],
    tokenByAddress: () => token,
    get: () => ({ metadata: JSON.stringify(metadata) }),
    run: (_sql, serialized) => { metadata = JSON.parse(serialized); },
    project() {},
    diagnostic() {},
    current: () => true,
  };
  const market = Object.create(MarketService.prototype);
  Object.assign(market, { repo, stopped: false, changed() {}, invalidateInventory() {}, refreshMissingLogos() {} });

  const report = market.reportLogoFailure("eth", ADDRESS, badLogo);
  assert.equal(report.retrying, true);
  assert.equal(metadata.logo, badLogo, "failed remote URL stays available as recovery history");
  assert.ok(metadata.logoLookup.failedUrls.includes(badLogo));

  assert.equal(market.storeLogo(token, "ave", newLogo), true);
  assert.equal(metadata.logo, newLogo);
  assert.equal(metadata.sources.logo.provider, "ave");
});
