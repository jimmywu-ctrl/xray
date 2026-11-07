// Compatibility test for the persisted legacy history migration.
import test from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/infra/database.mjs";
import { IngestionService } from "../src/services/ingestion.mjs";
import { StatisticsService } from "../src/services/statistics.mjs";
import { MarketService } from "../src/services/market.mjs";
import { now } from "../src/domain/rules.mjs";

let seq = 0;
const addr = (n) => "0x" + String(n).padStart(40, "0");
function setup(repo = new Repository(":memory:")) {
  const ingestion = new IngestionService(repo);
  const statistics = new StatisticsService(repo);
  const market = new MarketService(repo, null, statistics, ingestion);
  return { repo, ingestion, statistics, market };
}
function call(ingestion, address, at = now() - 60) {
  ingestion.ingest({ source: "telegram", channel: "tg:1", message: String(++seq), at, addresses: [address], chain: "bsc", sender: "s", senderId: "u1" });
}
const job = (repo, address) => repo.get("SELECT * FROM jobs WHERE lane='history' AND address=?", address);
test("migration history-once runs once: answered jobs DONE, never-answered kept", () => {
  const repo = new Repository(":memory:");
  const { ingestion, statistics } = setup(repo);
  const at = now() - 7200;
  for (let i = 30; i <= 37; i++) call(ingestion, addr(i), at);
  repo.run("DELETE FROM jobs");
  const v = (a) => repo.claim("bsc", a).version;
  const add = (i, payload, state = "QUEUED", err = null) => {
    repo.enqueue("history", "bsc", addr(i), v(addr(i)), payload);
    repo.run("UPDATE jobs SET state=?,last_error=? WHERE address=?", state, err, addr(i));
  };
  add(30, { cursor: at + 600, gaps: [] });                                   // progressed → DONE
  add(31, {});                                                                // has peak evidence → DONE
  statistics.write("bsc", addr(31), v(addr(31)), "baseline", { provider: "ave", mc: 100000, price: 0.0001, at: at - 1, precision: "second", basis: "same-source-mcap-candle", estimated: false });
  statistics.write("bsc", addr(31), v(addr(31)), "peak", { provider: "ave", mc: 300000, price: 0.0003, at: at + 30, precision: "1m", basis: "same-source-mcap-candle", estimated: false });
  add(32, { cursor: at + 1, gaps: [], empty: 1 }, "BACKOFF", "喊后区间暂无有效 K 线，稍后重试"); // answered empty → DONE
  add(33, {}, "BACKOFF", "仅返回未完成或跨喊单 K 线");                      // answered, incomplete only → DONE
  add(34, {}, "BACKOFF", "请求超时，结果已失效");                            // network only → kept
  add(35, {});                                                                // never run → kept
  add(36, {}, "PARKED", "等待喊前基准");                                     // parked → untouched
  add(37, { cursor: at + 1 }, "QUEUED");                                      // cursor not past the call → kept
  const peak = repo.get("SELECT COUNT(*) n FROM evidence WHERE address=? AND kind='peak' AND accepted=1 AND revoked=0", addr(31)).n;
  assert.equal(peak, 1, "fixture: accepted peak evidence");
  repo.run("DELETE FROM settings WHERE key='migration.history-once'");
  repo.migrate();
  const m = repo.setting("migration.history-once");
  assert.deepEqual([m.historyDone, m.historyRemaining], [4, 3]);
  const st = (i) => job(repo, addr(i)).state;
  assert.deepEqual([30, 31, 32, 33, 34, 35, 36, 37].map(st), ["DONE", "DONE", "DONE", "DONE", "BACKOFF", "QUEUED", "PARKED", "QUEUED"]);
  add(35, { cursor: at + 900 });
  repo.migrate();
  assert.equal(st(35), "QUEUED", "migration runs only once");
});
