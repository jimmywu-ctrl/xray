import fs from "node:fs";
import {BackgroundProjection} from "./background-projection.mjs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { fileURLToPath } from "node:url";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { sanitizeMarketQuote } from '../adapters/core/quote-contract.mjs';
import { now, rank, CAPTURE_QUIET_WINDOW_SEC, RECENT_WINDOW_SEC, CAPTURE_REFRESH_INTERVAL_SEC } from "../domain/rules.mjs";
import { HISTORY_WINDOW_SEC, LANE_MAX_ATTEMPTS, NODATA_RETRY_SEC, RETRY_MAX_ATTEMPTS, isTransientMarketError } from "./worker.mjs";
/** last_error texts of "the source answered but had nothing usable" failures (pre retry-once code included). */
const NO_DATA_ERRORS = [
  "尚无喊前有效基准，保留待补",
  "资料不全（缺名称或图标），稍后再补",
  "资料源均未返回可用数据",
  "暂无匹配的代币资料，保留待确认",
  "尚不能确认合约所属链",
  "喊后区间暂无有效 K 线，稍后重试",
  "仅返回未完成或跨喊单 K 线",
  "AVE 历史 K 线暂无有效数据",
];
const DIAGNOSTIC_REPEAT_WINDOW_SEC = 600;
const DIAGNOSTIC_RETENTION_SEC = 86400;
const DIAGNOSTIC_MAX_ROWS = 50000;
const DIAGNOSTIC_ALWAYS = new Set(["task_health", "attribution", "startup", "worker", "source_metrics"]);
export class Repository {
  constructor(filename) {
    if (filename !== ":memory:")
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("busy_timeout=5000");
    this.db.exec(
      fs.readFileSync(
        fileURLToPath(new URL("./schema.sql", import.meta.url)),
        "utf8",
      ),
    );
    this.projectionCache = new Map();
    this.projectDirty = false;
    this.projectTimer = null;
    this.mentionsRevision = 0;
    this.performanceMetrics = new Map();
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopDelay.enable();
    this.performanceStartedAt = Date.now();
    this.diagnosticSeen = new Map();
    this.diagnosticWrites = 0;
    this.migrate();
    this.recoverRunningJobs();
  }
  /** Resume interrupted work with its retry budget intact; repeated restarts cannot retry forever. */
  recoverRunningJobs(leaseExpiredBefore = null) {
    const ts = now();
    const expiredOnly = leaseExpiredBefore != null;
    return this.run(
        `UPDATE jobs SET
          state=CASE WHEN COALESCE(json_extract(payload,'$.failureAttempts'),json_extract(payload,'$.manualAttempts'),attempts)+1>=? THEN 'PARKED' ELSE 'BACKOFF' END,
          wait=CASE WHEN COALESCE(json_extract(payload,'$.failureAttempts'),json_extract(payload,'$.manualAttempts'),attempts)+1>=? THEN 'limit' ELSE NULL END,
          payload=json_set(payload,'$.failureAttempts',COALESCE(json_extract(payload,'$.failureAttempts'),json_extract(payload,'$.manualAttempts'),attempts)+1,
            '$.manualAttempts',CASE WHEN json_extract(payload,'$.manual')=1 THEN COALESCE(json_extract(payload,'$.failureAttempts'),json_extract(payload,'$.manualAttempts'),attempts)+1 ELSE COALESCE(json_extract(payload,'$.manualAttempts'),0) END),
          attempts=attempts+1,due=?,lease=NULL,lease_until=NULL,
          last_error='查询中断；已放回队列并计入有限重试次数',updated_at=?
          WHERE state='RUNNING'${expiredOnly ? ' AND lease_until<?' : ''}`,
        RETRY_MAX_ATTEMPTS, RETRY_MAX_ATTEMPTS, ts + 5, ts,
        ...(expiredOnly ? [leaseExpiredBefore] : []),
      ).changes;
  }
  /** Idempotent startup migrations. */
  migrate() {
    if (!this.all('PRAGMA table_info(price_results)').some(c => c.name === 'observed_peak'))
      this.db.exec('ALTER TABLE price_results ADD COLUMN observed_peak TEXT');
    const columns = this.db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
    if (!columns.includes("wait")) this.db.exec("ALTER TABLE jobs ADD COLUMN wait TEXT");
    if (!this.get("SELECT 1 FROM settings WHERE key='migration.stuckfix1'")) this.migrateStuckfix1();
    if (!this.get("SELECT 1 FROM settings WHERE key='migration.trim1'")) this.migrateTrim1();
    if (!this.get("SELECT 1 FROM settings WHERE key='migration.history-once'")) this.migrateHistoryOnce();
    if (!this.get("SELECT 1 FROM settings WHERE key='migration.retry-once'")) this.migrateRetryOnce();
    if (!this.setting('migration.capture-quiet-window-12h-v1', null)) this.transaction(() => {
      const ts = now();
      const extended = this.run(`
        UPDATE jobs SET due=(
          SELECT t.last_call + ? FROM tokens t
          WHERE t.chain=jobs.chain AND t.address=jobs.address
        ),updated_at=?
        WHERE lane='capture' AND state='QUEUED' AND wait IS NULL
          AND json_extract(payload,'$.stage')='history'
          AND COALESCE(json_extract(payload,'$.manualBatchId'),'')=''
          AND due=(
            SELECT t.last_call + 21600 FROM tokens t
            WHERE t.chain=jobs.chain AND t.address=jobs.address
          )
      `, CAPTURE_QUIET_WINDOW_SEC, ts).changes;
      this.set('migration.capture-quiet-window-12h-v1', { at: ts, extended });
      if (extended) this.diagnostic('startup', null, `已将 ${extended} 个自动喊后行情任务从 6 小时静默窗口延长到 12 小时`);
    });
    if (!this.setting('migration.acquisition-once-v1', null)) this.transaction(() => {
      const ended=this.run("UPDATE jobs SET state='PARKED',wait='nodata',lease=NULL,lease_until=NULL,updated_at=? WHERE state IN('BACKOFF','QUEUED') AND (attempts>0 OR wait='nodata')",now()).changes;
      this.set('migration.acquisition-once-v1',{at:now(),ended});
    });
    if (!this.setting('migration.capture-single-lane-v1', null)) this.transaction(() => {
      const stopped=this.run("UPDATE jobs SET state='PARKED',wait='superseded',lease=NULL,lease_until=NULL,last_error='已切换为单代币采集任务；保留已有结果，不再执行旧多队列',updated_at=? WHERE lane IN('verify','metadata','baseline','history') AND state IN('QUEUED','BACKOFF','RUNNING')",now()).changes;
      this.set('migration.capture-single-lane-v1',{at:now(),stopped});
    });
    if (!this.setting('migration.price-multiple-backfill-v1', null)) this.transaction(() => {
      const ts=now();
      let repaired=0;
      const rows=this.all("SELECT chain,address,claim_version,baseline,peak FROM price_results WHERE baseline IS NOT NULL AND peak IS NOT NULL");
      for(const row of rows){
        let baseline,peak;
        try{baseline=JSON.parse(row.baseline);peak=JSON.parse(row.peak);}catch{continue;}
        const basePrice=Number(baseline?.price),peakPrice=Number(peak?.price);
        if(peak?.multiple!=null||baseline?.provider!==peak?.provider||
          (baseline?.unit??'price')!=='price'||(peak?.unit??'price')!=='price'||
          !(Number.isFinite(basePrice)&&basePrice>0&&Number.isFinite(peakPrice)&&peakPrice>0)||
          Number(peak?.baselineAt)!==Number(baseline?.at))continue;
        peak.multiple=peakPrice/basePrice;
        peak.baselinePrice=peak.baselinePrice??basePrice;
        this.run('UPDATE price_results SET peak=?,updated_at=? WHERE chain=? AND address=? AND claim_version=?',JSON.stringify(peak),ts,row.chain,row.address,row.claim_version);
        repaired++;
      }
      this.set('migration.price-multiple-backfill-v1',{at:ts,repaired});
      this.diagnostic('price_multiple_backfill',null,`补算 ${repaired} 条同源、同单位、同喊单基准的旧记录`);
    });
    if (!this.setting('migration.remove-ave-v1', null)) this.transaction(() => {
      const quoteSources = this.setting('quoteSources', {});
      let migratedQuoteSources = 0;
      if (quoteSources && typeof quoteSources === 'object' && !Array.isArray(quoteSources)) {
        for (const [key, provider] of Object.entries(quoteSources)) {
          if (provider === 'ave') {
            quoteSources[key] = 'dex';
            migratedQuoteSources++;
          }
        }
        this.set('quoteSources', quoteSources);
      }
      this.set('quoteSource', 'dex');
      this.set('acquisitionSource', 'ave');
      this.set('migration.remove-ave-v1', { at: now(), migratedQuoteSources });
    });
    if (!this.setting('migration.acquisition-source-ave-v2', null)) this.transaction(() => {
      this.set('acquisitionSource', 'ave');
      this.set('migration.acquisition-source-ave-v2', { at: now() });
    });
    if (!this.setting('migration.retry-transient-capture-v1', null)) this.transaction(() => {
      const ts = now();
      const transient = `(
        lower(last_error) LIKE '%timeout%' OR lower(last_error) LIKE '%timed out%' OR last_error LIKE '%超时%' OR
        lower(last_error) LIKE '%http 429%' OR lower(last_error) LIKE '%http 403%' OR lower(last_error) LIKE '%http 5%'
        OR lower(last_error) LIKE '%econn%' OR lower(last_error) LIKE '%etimedout%' OR lower(last_error) LIKE '%network%'
        OR lower(last_error) LIKE '%socket%' OR lower(last_error) LIKE '%fetch failed%' OR last_error LIKE '%限流%' OR last_error LIKE '%验证页%'
      )`;
      const recovered = this.run(
        `UPDATE jobs SET
          state=CASE WHEN attempts>=? THEN 'PARKED' ELSE 'BACKOFF' END,
          wait=CASE WHEN attempts>=? THEN 'limit' ELSE NULL END,
          payload=json_set(payload,'$.failureAttempts',COALESCE(json_extract(payload,'$.failureAttempts'),attempts)),
          due=?,last_error=last_error||'（升级后恢复一次，后续最多重试至 3 次）',updated_at=?
          WHERE lane='capture' AND state='FAILED' AND COALESCE(json_extract(payload,'$.manual'),0)<>1
            AND EXISTS(SELECT 1 FROM tokens t WHERE t.chain=jobs.chain AND t.address=jobs.address AND t.last_call>=?)
            AND ${transient}`,
        RETRY_MAX_ATTEMPTS, RETRY_MAX_ATTEMPTS, ts + 5, ts, ts - 6 * 3600,
      ).changes;
      this.set('migration.retry-transient-capture-v1', { at: ts, recovered });
      if (recovered) this.diagnostic('startup', null, `已恢复 ${recovered} 个近期网络错误任务；后续每项最多尝试 ${RETRY_MAX_ATTEMPTS} 次`);
    });
    if (!this.setting('migration.monitor-repair-24h-v1', null)) this.transaction(() => {
      const ts = now(); let recovered = 0, scheduled = 0;
      const failed = this.all(`SELECT j.id,j.last_error,j.payload FROM jobs j
        JOIN claims c ON c.chain=j.chain AND c.address=j.address AND c.version=j.claim_version AND c.active=1
        JOIN tokens t ON t.chain=j.chain AND t.address=j.address
        WHERE j.lane='capture' AND j.state='FAILED' AND t.last_call>=?`, ts - RECENT_WINDOW_SEC);
      for (const row of failed) {
        if (!isTransientMarketError(row.last_error)) continue;
        const payload = { ...JSON.parse(row.payload || '{}'), failureAttempts: 0 };
        this.run("UPDATE jobs SET state='BACKOFF',wait=NULL,attempts=0,due=?,payload=?,lease=NULL,lease_until=NULL,updated_at=? WHERE id=?",
          ts + 5 + recovered * 5, JSON.stringify(payload), ts, row.id);
        recovered++;
      }
      const delayed = this.all(`SELECT j.id,j.payload FROM jobs j
        JOIN claims c ON c.chain=j.chain AND c.address=j.address AND c.version=j.claim_version AND c.active=1
        JOIN tokens t ON t.chain=j.chain AND t.address=j.address
        WHERE j.lane='capture' AND j.state IN('QUEUED','DONE') AND t.last_call>=?
          AND json_extract(j.payload,'$.stage')='history'
          AND COALESCE(json_extract(j.payload,'$.manualBatchId'),'')=''`, ts - RECENT_WINDOW_SEC);
      for (const row of delayed) {
        const payload = { ...JSON.parse(row.payload || '{}'), stage:'history', refresh:true };
        this.run("UPDATE jobs SET state='QUEUED',due=?,payload=?,updated_at=? WHERE id=?", ts + 30 + scheduled * 5, JSON.stringify(payload), ts, row.id);
        scheduled++;
      }
      this.set('migration.monitor-repair-24h-v1', { at:ts, recovered, scheduled });
      this.diagnostic('startup', null, `24小时监控修复：恢复 ${recovered} 个网络失败任务，安排 ${scheduled} 个历史增量任务`);
    });
    for (const recoveryVersion of ['migration.ave-session-proxy-recovery-v1','migration.ave-origin-recovery-v1']) if (!this.setting(recoveryVersion, null)) this.transaction(() => {
      const ts=now(); let recovered=0;
      const rows=this.all(`SELECT j.id,j.payload FROM jobs j
        JOIN claims c ON c.chain=j.chain AND c.address=j.address AND c.version=j.claim_version AND c.active=1
        JOIN tokens t ON t.chain=j.chain AND t.address=j.address
        WHERE j.lane='capture' AND j.state IN('FAILED','PARKED','BACKOFF')
          AND (j.wait IS NULL OR j.wait='limit') AND t.last_call>=?
          AND j.last_error LIKE '%ERR_CONNECTION%'`,ts-RECENT_WINDOW_SEC);
      for(const row of rows){
        const payload={...JSON.parse(row.payload||'{}'),failureAttempts:0};
        this.run("UPDATE jobs SET state='BACKOFF',wait=NULL,attempts=0,due=?,payload=?,lease=NULL,lease_until=NULL,updated_at=? WHERE id=?",ts+5+recovered*3,JSON.stringify(payload),ts,row.id);
        recovered++;
      }
      this.set(recoveryVersion,{at:ts,recovered});
      if(recovered)this.diagnostic('startup',null,`AVE查询连接修复后，恢复 ${recovered} 个连接失败任务`);
    });
    if (!this.setting('migration.capture-baseline-wait-v1',null)) this.transaction(()=>{
      const rows=this.all(`SELECT j.id,j.payload FROM jobs j JOIN claims c ON c.chain=j.chain AND c.address=j.address AND c.version=j.claim_version AND c.active=1
        WHERE j.lane='capture' AND j.state='PARKED' AND j.wait='baseline'
          AND NOT EXISTS(SELECT 1 FROM price_results p WHERE p.chain=c.chain AND p.address=c.address AND p.claim_version=c.version AND p.baseline IS NOT NULL)`);
      for(const row of rows){const payload={...JSON.parse(row.payload||'{}'),stage:'baseline'};
        this.run("UPDATE jobs SET state='QUEUED',wait=NULL,due=?,payload=?,updated_at=? WHERE id=?",now()+5,JSON.stringify(payload),now(),row.id);}
      const unknown=this.all(`SELECT j.id,t.address,t.metadata,j.last_error FROM jobs j JOIN claims c ON c.chain=j.chain AND c.address=j.address AND c.version=j.claim_version AND c.active=1
        JOIN tokens t ON t.chain=c.chain AND t.address=c.address
        WHERE j.lane='capture' AND j.chain='?' AND j.state='PARKED' AND j.wait='limit' AND t.last_call>=?
          AND COALESCE(json_extract(t.metadata,'$.manualDisposition'),'')<>'wallet'
          AND COALESCE(json_extract(t.metadata,'$.autoDisposition'),'') NOT IN('wallet','unlisted')`,now()-RECENT_WINDOW_SEC);
      let resumedChains=0;
      for(const row of unknown){
        if(!isTransientMarketError(row.last_error))continue;
        const metadata=JSON.parse(row.metadata||'{}');metadata.chainResolutionFallback={...metadata.chainResolutionFallback,attempts:0,complete:false,retryAt:now()};
        this.run("UPDATE tokens SET metadata=? WHERE chain='?' AND address=?",JSON.stringify(metadata),row.address);
        this.run("UPDATE jobs SET state='QUEUED',wait=NULL,due=?,attempts=0,payload=json_set(payload,'$.failureAttempts',0),updated_at=? WHERE id=?",now()+5,now(),row.id);resumedChains++;
      }
      this.set('migration.capture-baseline-wait-v1',{at:now(),recovered:rows.length,resumedChains});
    });
  }
  /** One-off: "no data" failures get a single retry. BACKOFF data failures with ≥2 attempts end now; 1 attempt keeps one retry. */
  migrateRetryOnce() {
    this.transaction(() => {
      const ts = now();
      const data = `state='BACKOFF' AND last_error IN(${NO_DATA_ERRORS.map((m) => `'${m}'`).join(",")})`;
      const metadataDone = this.run(
        `UPDATE jobs SET state='DONE',wait=NULL,lease=NULL,lease_until=NULL,updated_at=? WHERE lane='metadata' AND attempts>=2 AND ${data}`,
        ts,
      ).changes;
      const ended = this.run(
        `UPDATE jobs SET state='PARKED',wait='nodata',lease=NULL,lease_until=NULL,updated_at=? WHERE lane<>'metadata' AND attempts>=2 AND ${data}`,
        ts,
      ).changes;
      const retryOnce = this.run(
        `UPDATE jobs SET wait='nodata',due=MIN(due,?),updated_at=? WHERE attempts<2 AND ${data}`,
        ts + NODATA_RETRY_SEC,
        ts,
      ).changes;
      this.wakeSatisfied();
      this.set("migration.retry-once", { at: ts, metadataDone, ended, retryOnce });
    });
  }
  /** One-off: history is a single query per claim; jobs that already got at least one answer (data, cursor progress, or an empty answer) are finished. */
  migrateHistoryOnce() {
    this.transaction(() => {
      const ts = now();
      const done = this.run(
        "UPDATE jobs SET state='DONE',lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE lane='history' AND state IN('QUEUED','BACKOFF') AND (COALESCE(json_extract(jobs.payload,'$.cursor'),0)>(SELECT c.at+1 FROM claims c WHERE c.chain=jobs.chain AND c.address=jobs.address) OR EXISTS(SELECT 1 FROM evidence e WHERE e.chain=jobs.chain AND e.address=jobs.address AND e.claim_version=jobs.claim_version AND e.kind='peak' AND e.accepted=1 AND e.revoked=0) OR json_extract(jobs.payload,'$.empty') IS NOT NULL OR jobs.last_error IN('喊后区间暂无有效 K 线，稍后重试','仅返回未完成或跨喊单 K 线'))",
        ts,
      ).changes;
      const kept = this.get("SELECT COUNT(*) n FROM jobs WHERE lane='history' AND state IN('QUEUED','BACKOFF')").n;
      this.set("migration.history-once", { at: ts, historyDone: done, historyRemaining: kept });
    });
  }
  /** One-off: finish history beyond the configured query window, stop periodic metadata refresh, park capped verify/metadata. */
  migrateTrim1() {
    this.transaction(() => {
      const ts = now();
      const history = this.run(
        "UPDATE jobs SET state='DONE',lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE lane='history' AND state IN('QUEUED','BACKOFF') AND EXISTS(SELECT 1 FROM claims c WHERE c.chain=jobs.chain AND c.address=jobs.address AND c.at<? AND COALESCE(json_extract(jobs.payload,'$.cursor'),0)>=c.at+?)",
        ts,
        ts - HISTORY_WINDOW_SEC,
        HISTORY_WINDOW_SEC,
      ).changes;
      const metadata = this.run(
        "UPDATE jobs SET state='DONE',lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE lane='metadata' AND state IN('QUEUED','BACKOFF') AND EXISTS(SELECT 1 FROM tokens t WHERE t.chain=jobs.chain AND t.address=jobs.address AND COALESCE(json_extract(t.metadata,'$.symbol'),json_extract(t.metadata,'$.name')) IS NOT NULL AND json_extract(t.metadata,'$.logo') IS NOT NULL)",
        ts,
      ).changes;
      let parked = 0;
      for (const [lane, limit] of Object.entries(LANE_MAX_ATTEMPTS))
        parked += this.run(
          "UPDATE jobs SET state='PARKED',wait='limit',lease=NULL,lease_until=NULL,updated_at=? WHERE lane=? AND state='BACKOFF' AND attempts>=?",
          ts,
          lane,
          limit,
        ).changes;
      this.set("migration.trim1", { at: ts, historyDone: history, metadataDone: metadata, capParked: parked });
    });
  }
  migrateStuckfix1() {
    this.transaction(() => {
      const ts = now();
      // Jobs of unresolved-chain tokens cannot make progress: only the verify lane may run for them.
      const chain = this.run(
        "UPDATE jobs SET state='PARKED',wait='chain',lease=NULL,lease_until=NULL,last_error='等待确认所属链',updated_at=? WHERE chain='?' AND lane IN('metadata','baseline','history') AND state IN('QUEUED','BACKOFF','RUNNING')",
        ts,
      ).changes;
      const verify = this.run(
        "UPDATE jobs SET state='PARKED',wait='verify',lease=NULL,lease_until=NULL,last_error='代币尚未确认，暂不定锚',updated_at=? WHERE lane='baseline' AND chain<>'?' AND state IN('QUEUED','BACKOFF') AND EXISTS(SELECT 1 FROM tokens t WHERE t.chain=jobs.chain AND t.address=jobs.address AND t.verified=0)",
        ts,
      ).changes;
      const baseline = this.run(
        "UPDATE jobs SET state='PARKED',wait='baseline',lease=NULL,lease_until=NULL,last_error='等待喊前基准',updated_at=? WHERE lane='history' AND chain<>'?' AND state IN('QUEUED','BACKOFF') AND NOT EXISTS(SELECT 1 FROM results r WHERE r.chain=jobs.chain AND r.address=jobs.address AND r.baseline_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM price_results p WHERE p.chain=jobs.chain AND p.address=jobs.address AND p.claim_version=jobs.claim_version AND p.baseline IS NOT NULL)",
        ts,
      ).changes;
      // Give the new chain fallbacks a few fair tries before the attempt limit parks them.
      const retry = this.run(
        "UPDATE jobs SET attempts=MIN(attempts,9),due=MIN(due,?) WHERE lane='verify' AND chain='?' AND state='BACKOFF'",
        ts + 60,
      ).changes;
      this.set("migration.stuckfix1", { at: ts, parkedChain: chain, parkedVerify: verify, parkedBaseline: baseline, verifyRetry: retry });
    });
  }
  /** Re-queue a parked job when its precondition is satisfied. */
  wake(lane, chain, address, version) {
    return this.run(
      "UPDATE jobs SET state='QUEUED',wait=NULL,due=?,attempts=0,last_error=NULL,updated_at=? WHERE lane=? AND chain=? AND address=? AND claim_version=? AND state='PARKED' AND COALESCE(wait,'') NOT IN('nodata','limit','superseded')",
      now(),
      now(),
      lane,
      chain,
      address,
      version,
    ).changes;
  }
  /** Periodic safety net for wake races, plus a slow retry of jobs parked by the attempt limit. */
  wakeSatisfied() {
    const ts = now();
    let woken = 0;
    woken += this.run(
      "UPDATE jobs SET state='QUEUED',wait=NULL,due=?,attempts=0,last_error=NULL,updated_at=? WHERE state='PARKED' AND wait='verify' AND EXISTS(SELECT 1 FROM tokens t WHERE t.chain=jobs.chain AND t.address=jobs.address AND t.verified=1)",
      ts,
      ts,
    ).changes;
    woken += this.run(
      "UPDATE jobs SET state='QUEUED',wait=NULL,due=?,attempts=0,last_error=NULL,updated_at=? WHERE state='PARKED' AND wait='baseline' AND EXISTS(SELECT 1 FROM results r WHERE r.chain=jobs.chain AND r.address=jobs.address AND r.baseline_id IS NOT NULL)",
      ts,
      ts,
    ).changes;
    // Limit/no-data parked jobs are never revived automatically (only a new claim or a manual repair re-queues them).
    // A job waiting on an upstream job that has ended (no data / limit / failed) ends too instead of hanging.
    const ended = (lane) =>
      `EXISTS(SELECT 1 FROM jobs u WHERE u.lane='${lane}' AND u.chain=jobs.chain AND u.address=jobs.address AND u.claim_version=jobs.claim_version AND (u.state='FAILED' OR (u.state='PARKED' AND u.wait IN('nodata','limit','upstream'))))`;
    this.run(
      `UPDATE jobs SET wait='upstream',last_error='上游任务已结束：'||COALESCE(last_error,''),updated_at=? WHERE state='PARKED' AND ((wait IN('verify','chain') AND ${ended("verify")}) OR (wait='baseline' AND ${ended("baseline")}))`,
      ts,
    );
    return woken;
  }
  transaction(fn) {
    return this.db.transaction(fn).immediate();
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  setting(key, fallback) {
    const row = this.get("SELECT value FROM settings WHERE key=?", key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.run(
      "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  diagnostic(category, token, detail) {
    let safe = String(detail).replace(
      /(?:api[_-]?hash|authorization|access[_-]?token|cookie|password|api[_-]?key)([=:]\s*)[^\s,;]+/gi,
      "[redacted]",
    );
    const ts = now();
    // Collapse identical repeated failures: one row per (category, token, reason) per 10 minutes.
    if (!DIAGNOSTIC_ALWAYS.has(category)) {
      const key = `${category}|${token ?? ""}|${safe.replace(/\d{6,}/g, "#").slice(0, 300)}`;
      const seen = this.diagnosticSeen.get(key);
      if (seen && ts - seen.at < DIAGNOSTIC_REPEAT_WINDOW_SEC) {
        seen.suppressed++;
        return;
      }
      if (seen?.suppressed) safe += `（此前 ${Math.round((ts - seen.at) / 60)} 分钟内重复 ${seen.suppressed} 次）`;
      this.diagnosticSeen.set(key, { at: ts, suppressed: 0 });
      if (this.diagnosticSeen.size > 20000)
        for (const [k, v] of this.diagnosticSeen)
          if (ts - v.at >= DIAGNOSTIC_REPEAT_WINDOW_SEC) this.diagnosticSeen.delete(k);
    }
    this.run(
      "INSERT INTO diagnostics(at,category,token,detail) VALUES(?,?,?,?)",
      ts,
      category,
      token ?? null,
      safe.slice(0, 2000),
    );
    // Time-based retention (24h) with a hard row cap; pruning runs periodically, not on every insert.
    if (++this.diagnosticWrites % 200 === 1)
      this.run(
        "DELETE FROM diagnostics WHERE at<? OR id<(SELECT COALESCE(MAX(id),0)-? FROM diagnostics)",
        ts - DIAGNOSTIC_RETENTION_SEC,
        DIAGNOSTIC_MAX_ROWS,
      );
  }
  claim(chain, address) {
    return this.get(
      "SELECT c.*,t.verified,t.blocked,t.metadata,t.last_call,m.sender,m.sender_key,m.source,m.channel FROM claims c JOIN tokens t USING(chain,address) LEFT JOIN mentions m ON m.id=c.owner WHERE c.chain=? AND c.address=?",
      chain,
      address,
    );
  }
  current(chain, address, version) {
    const c = this.claim(chain, address);
    return !!c?.active && c.version === version && !c.blocked;
  }
  enqueue(
    lane,
    chain,
    address,
    version,
    payload = {},
    priority = 10,
    due = now(),
  ) {
    // The single capture handler also resolves an unknown EVM chain.
    if (chain === "?" && lane !== "capture" && lane !== "verify") return;
    this.run(
      `INSERT INTO jobs(lane,chain,address,claim_version,payload,state,priority,due,updated_at) VALUES(?,?,?,?,?,'QUEUED',?,?,?) ON CONFLICT(lane,chain,address,claim_version) DO UPDATE SET payload=CASE WHEN jobs.state='RUNNING' THEN jobs.payload ELSE excluded.payload END,attempts=CASE WHEN jobs.state='PARKED' THEN 0 ELSE jobs.attempts END,wait=CASE WHEN jobs.state='RUNNING' THEN jobs.wait ELSE NULL END,state=CASE WHEN jobs.state='RUNNING' THEN jobs.state ELSE 'QUEUED' END,due=MIN(jobs.due,excluded.due),priority=MIN(jobs.priority,excluded.priority),updated_at=excluded.updated_at`,
      lane,
      chain,
      address,
      version,
      JSON.stringify(payload),
      priority,
      due,
      now(),
    );
  }
  evidence(id) {
    const row = id ? this.get("SELECT * FROM evidence WHERE id=?", id) : null;
    return row
      ? { ...JSON.parse(row.payload), id: row.id, revoked: !!row.revoked }
      : null;
  }
  view({ address = null, chain = null, since = null, limit = null, reuse = false } = {}) {
    const started = performance.now();
    const conditions = ["c.active=1", "t.blocked=0", "t.verified=1", "c.chain<>'?'"];
    const params = [JSON.stringify(this.setting("quoteSources", {})), this.setting("quoteSource", "dex")];
    if (address != null) {
      conditions.push("c.address=?");
      params.push(/^0x/i.test(address) ? address.toLowerCase() : address);
    }
    if (chain != null) { conditions.push("c.chain=?"); params.push(chain); }
    if (since != null) { conditions.push("t.last_call>=?"); params.push(since); }
    const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? ` LIMIT ${limit}` : "";
    const rows = this.all(
      `SELECT c.chain,c.address,c.version,c.at,t.metadata,t.verified,t.last_call,m.sender,m.sender_key,m.source,m.channel,
       COALESCE(q.payload,(SELECT q2.payload FROM quotes q2 WHERE q2.chain=c.chain AND q2.address=c.address ORDER BY q2.received_at DESC,q2.generation DESC LIMIT 1)) quote_payload,
       COALESCE(q.received_at,(SELECT q2.received_at FROM quotes q2 WHERE q2.chain=c.chain AND q2.address=c.address ORDER BY q2.received_at DESC,q2.generation DESC LIMIT 1)) received_at,
       pr.baseline price_baseline,pr.peak price_peak,pr.observed_peak
      FROM claims c JOIN tokens t USING(chain,address) JOIN mentions m ON m.id=c.owner
      LEFT JOIN price_results pr ON pr.chain=c.chain AND pr.address=c.address AND pr.claim_version=c.version
      LEFT JOIN quotes q ON q.chain=c.chain AND q.address=c.address AND q.provider=COALESCE(json_extract(?, '$."'||c.chain||':'||c.address||'"'),?)
      WHERE ${conditions.join(" AND ")} ORDER BY t.last_call DESC,c.address${boundedLimit}`,
      ...params,
    );
    const queriedAt = performance.now();
    const rowCache=reuse?(this.liveRowCache??=new Map()):null;
    const activeKeys=new Set();
    const result = rows.map((r) => {
      const key=`${r.chain}:${r.address}`;activeKeys.add(key);
      const cached=rowCache?.get(key);
      if(cached&&Object.keys(r).every(field=>r[field]===cached.raw[field]))return cached.value;
      const decodedAt=performance.now();
      const priceBaseline=r.price_baseline?JSON.parse(r.price_baseline):null,pricePeak=r.price_peak?JSON.parse(r.price_peak):null;
      const value = {
        chain: r.chain,
        address: r.address,
        version: r.version,
        at: r.at,
        sender: r.sender,
        senderKey: r.sender_key,
        source: r.source,
        channel: r.channel,
        lastCall: r.last_call,
        verified: !!r.verified,
        ...JSON.parse(r.metadata),
        status: pricePeak ? (pricePeak.approximate ? "ready_approx" : "ready_exact") : priceBaseline ? "waiting_peak" : "pending_token",
        baseline: priceBaseline,
        priceBaseline,pricePeak,priceMultiple:pricePeak?.multiple??null,priceApproximate:!!pricePeak?.approximate,
        observedPeak:r.observed_peak?JSON.parse(r.observed_peak):null,
        formalPeak: null,
        referencePeak: null,
        formalMultiple: null,
        referenceMultiple: null,
        lowest: null,
        maxObservedLossPct: null,
        quote: r.quote_payload ? sanitizeMarketQuote(JSON.parse(r.quote_payload)) : null,
        receivedAt: r.received_at ?? null,
      };
      if(rowCache){rowCache.set(key,{raw:r,value});this.recordPerformance('live_row_decode',performance.now()-decodedAt,1);}
      return value;
    });
    if(rowCache)for(const key of rowCache.keys())if(!activeKeys.has(key))rowCache.delete(key);
    if (since == null && address == null) {
      this.recordPerformance("project_query", queriedAt - started, rows.length);
      this.recordPerformance("project_parse", performance.now() - queriedAt, rows.length);
    }
    this.recordPerformance(since != null ? "live_view" : address != null ? "token_lookup" : "projection_view", performance.now() - started, result.length);
    return result;
  }
  tokenByAddress(address, chain = null) {
    return this.view({ address, chain, limit: 1 })[0] ?? null;
  }
  enableBackgroundProjection() {
    if(this.backgroundProjection)return;
    if(this.db.name===':memory:')throw Error('Background statistics require a file database');
    this.backgroundProjection=new BackgroundProjection(this);
    try{this.backgroundProjection.ensureWorker();}catch(error){this.backgroundProjection.failed(this.backgroundProjection.worker,error);}
  }
  /** Hot-path callers only mark statistics dirty; live cards read their own bounded view. */
  project({ mentionsChanged = false } = {}) {
    if (mentionsChanged) this.mentionsRevision++;
    this.projectDirty = true;
    if(this.backgroundProjection){this.backgroundProjection.invalidate();return this.projectionCache.get("overview");}
    if (!this.projectTimer) {
      this.projectTimer = setTimeout(() => {
        this.projectTimer = null;
        if (!this.projectDirty || !this.db.open) return;
        try {
          this.projectNow();
          this.onProjected?.();
        } catch (error) {
          this.projectDirty = true;
          console.error("[perf] projection rebuild failed:", error.message);
        }
      }, 250);
      this.projectTimer.unref();
    }
    return this.projectionCache.get("overview");
  }
  /** Startup / explicit consistency boundary; rebuild derived data in memory only. */
  projectNow() {
    this.backgroundProjection?.supersede();
    clearTimeout(this.projectTimer);
    this.projectTimer = null;
    const started = performance.now();
    const rows = this.view();
    const viewedAt = performance.now();
    const leaderboard = rank(rows);
    const rankedAt = performance.now();
    const overview = {
      total: rows.length,
      formal: rows.filter((r) => r.priceMultiple != null).length,
      reference: 0,
      pending: rows.filter((r) => r.priceMultiple == null).length,
      wins: rows.filter((r) => r.priceMultiple >= 2).length,
    };
    const summarizedAt = performance.now();
    for (const [key, value] of Object.entries({
      rows,
      leaderboard,
      overview,
    })) {
      this.projectionCache.set(key, value);
    }
    this.projectDirty = false;
    const elapsed = performance.now() - started;
    this.recordPerformance("project_rank", rankedAt - viewedAt, rows.length);
    this.recordPerformance("project_overview", summarizedAt - rankedAt, rows.length);
    this.recordPerformance("project_cache", performance.now() - summarizedAt, rows.length);
    this.recordPerformance("project", elapsed, rows.length);
    if (elapsed >= 500 || (elapsed >= 50 && Date.now() - (this.lastSlowProjectLog ?? 0) >= 60_000)) {
      this.lastSlowProjectLog = Date.now();
      console.error(JSON.stringify({ category: "slow_project", at: new Date().toISOString(), pid: process.pid, rows: rows.length, elapsedMs: +elapsed.toFixed(1), queryMs: this.performanceMetrics.get("project_query")?.lastMs, parseMs: this.performanceMetrics.get("project_parse")?.lastMs, rankMs: rankedAt - viewedAt, overviewMs: summarizedAt - rankedAt, cacheMs: performance.now() - summarizedAt }));
    }
    return overview;
  }
  projection(name, fallback) {
    return this.projectionCache.get(name) ?? fallback;
  }
  recordPerformance(name, elapsedMs, rows = null) {
    let metric = this.performanceMetrics.get(name);
    if (!metric) this.performanceMetrics.set(name, metric = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0, lastRows: null, samples: [] });
    metric.count++;
    metric.totalMs += elapsedMs;
    metric.maxMs = Math.max(metric.maxMs, elapsedMs);
    metric.lastMs = elapsedMs;
    metric.lastRows = rows;
    metric.samples.push(elapsedMs);
    if (metric.samples.length > 256) metric.samples.shift();
  }
  performanceSnapshot() {
    const timings = {};
    for (const [name, metric] of this.performanceMetrics) {
      const samples = [...metric.samples].sort((a, b) => a - b);
      const round = value => +value.toFixed(3);
      timings[name] = { count: metric.count, averageMs: round(metric.totalMs / metric.count), p95RecentMs: round(samples[Math.ceil(samples.length * .95) - 1]), maxMs: round(metric.maxMs), lastMs: round(metric.lastMs), lastRows: metric.lastRows };
    }
    return { build: "20261007-correction-icon-v5", pid: process.pid, eventLoopDelay: { meanMs: Number.isFinite(this.eventLoopDelay.mean) ? +(this.eventLoopDelay.mean / 1e6).toFixed(3) : null, p95Ms: +(this.eventLoopDelay.percentile(95) / 1e6).toFixed(3), maxMs: +(this.eventLoopDelay.max / 1e6).toFixed(3) }, startedAt: this.performanceStartedAt, projectionDirty: this.projectDirty, backgroundProjection: this.backgroundProjection?.status()??null, timings };
  }
  close() {
    void this.backgroundProjection?.stop()?.catch(()=>{});
    clearTimeout(this.projectTimer);
    this.projectTimer = null;
    this.onProjected = null;
    this.eventLoopDelay.disable();
    this.db.close();
  }
}
