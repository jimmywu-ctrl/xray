import { randomUUID } from "node:crypto";
import { now, CAPTURE_QUIET_WINDOW_SEC } from "../domain/rules.mjs";
export class RetryError extends Error {
  constructor(message, delay = 30) {
    super(message);
    this.delay = delay;
  }
}
/** The provider is deliberately paused; defer without counting this as a request attempt. */
export class DeferredError extends Error {
  constructor(message, delay = 30) {
    super(message);
    this.delay = Math.max(1, Number(delay) || 1);
    this.deferred = true;
  }
}
/** A completed provider round had no usable result. Keep its reason and permit one delayed retry. */
export class NoDataError extends Error {
  constructor(message, finalState = "PARKED") {
    super(message);
    this.noData = true;
    this.finalState = finalState;
  }
}
/** A precondition is missing (chain/verify/baseline). Not a failure: the job is parked and woken when the condition holds. */
export class WaitError extends Error {
  constructor(message, wait) {
    super(message);
    this.wait = wait;
  }
}
/** Transient transport/provider failures get a small, finite retry budget. */
export function isTransientMarketError(error) {
  const message=String(error?.message??error);
  const status=Number(error?.status??error?.statusCode??0);
  return error instanceof RetryError||['ApiRateLimitError','ApiAccessBlockedError'].includes(error?.name)||[403,408,425,429].includes(status)||status>=500||/HTTP\s*(?:403|408|425|429|5\d\d)|ERR_(?:CONNECTION|INTERNET|NETWORK|NAME|TIMED|PROXY|TUNNEL|ABORTED)|超时|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|network|fetch failed|连接|cancelled|aborted|限流|rate.?limit|challenge|non-JSON|invalid JSON|不是 JSON|JSON 外层格式/i.test(message);
}
export const RETRY_BASE_SEC = 5;
/** Empty AVE K-line answers park immediately; do not burn quota on delayed retries. */
export const NODATA_RETRY_DELAYS_SEC = [];
// Kept for the one-time database migration that resumes legacy retry-once jobs.
export const NODATA_RETRY_SEC = 300;
export const RETRY_MAX_DELAY_SEC = 3600;
export const RETRY_MAX_ATTEMPTS = 3;
/** Former 6h auto-retry of limit-parked jobs; no longer used (parked jobs are not revived). Kept for compatibility. */
export const LIMIT_PARK_RETRY_SEC = 6 * 3600;
/** Kept only for startup cleanup of old job rows; new work uses one capture lane. */
export const LANE_MAX_ATTEMPTS = { verify: 4, metadata: 4 };
export const LIMITED_LANE_DELAYS_SEC = [120, 600, 1800];
export const HISTORY_WINDOW_SEC = 6 * 3600;
/** Retry delay: never shorter than the handler's own hint, grows exponentially with attempts, capped. */
export function retryDelay(attempts, hint) {
  const exp = RETRY_BASE_SEC * 2 ** Math.min(Math.max(0, attempts), 20);
  return Math.min(RETRY_MAX_DELAY_SEC, Math.max(Number(hint) || 0, exp));
}
export class Worker {
  constructor(
    repo,
    handlers,
    {
      limits = { capture: 4 },
      timeoutMs = 75000,
      preferredTokens = () => [],
    } = {},
  ) {
    this.repo = repo;
    this.handlers = handlers;
    this.limits = limits;
    this.timeoutMs = timeoutMs;
    this.preferredTokens = preferredTokens;
    this.claimCounts = new Map();
    this.running = new Map();
    this.controllers=new Set();
    this.closing=false;
    this.stopped = true;
    this.completedAt = [];
    this.failedAt = [];
    this.lastLeaseRecovery = 0;
    this.lastWakeSweep = 0;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.closing=false;
    this.repo.set('workerHealth',{startedAt:now(),heartbeatAt:now(),lastFinishedAt:now(),completed10m:0,failed10m:0});
    this.sweep();
    this.tick();
  }
  scheduleTick(delay) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }
  claim(lane) {
    return this.repo.transaction(() => {
      const turn=(this.claimCounts.get(lane)??0)+1;
      const prioritized=turn%5!==0;
      // Keep one capture slot for a new shout. Historical work, retries, and
      // manual repair can use the other slots but cannot fill the whole lane.
      const backgroundCondition="(json_extract(jobs.payload,'$.manualBatchId') IS NOT NULL OR json_extract(jobs.payload,'$.stage')='history' OR jobs.attempts>0 OR COALESCE(json_extract(jobs.payload,'$.failureAttempts'),0)>0 OR NOT EXISTS(SELECT 1 FROM claims c WHERE c.chain=jobs.chain AND c.address=jobs.address AND c.active=1 AND c.at>=?))";
      const laneLimit=this.limits[lane]??1;
      const backgroundRunning=lane==='capture'&&laneLimit>1
        ? Number(this.repo.get(`SELECT COUNT(*) count FROM jobs WHERE lane=? AND state='RUNNING' AND ${backgroundCondition}`,lane,now()-3600)?.count||0)
        : 0;
      const reserveBackground=lane==='capture'&&laneLimit>1&&backgroundRunning>=laneLimit-1;
      // Fair order: earliest due first, fewer attempts first; id is only a tie-breaker.
      // Every 5th turn ignores tiers and serves first-try jobs first so new work always gets a share.
      // Within a tier the most recently called token goes first; the 5th-turn rotation keeps older work from starving.
      const order=prioritized ? "CASE WHEN jobs.chain||':'||jobs.address IN (SELECT value FROM json_each(?)) THEN 0 WHEN EXISTS(SELECT 1 FROM claims c WHERE c.chain=jobs.chain AND c.address=jobs.address AND c.active=1 AND c.at>=?) THEN 1 ELSE 2 END,priority,COALESCE((SELECT -c.at FROM claims c WHERE c.chain=jobs.chain AND c.address=jobs.address),0),due,attempts,id" : "attempts,due,id";
      const backgroundFilter=reserveBackground?` AND NOT ${backgroundCondition}`:"";
      const whereArgs=reserveBackground?[lane,now(),now()-3600]:[lane,now()];
      const orderArgs=prioritized?[JSON.stringify([...this.preferredTokens()].slice(0,100)),now()-3600]:[];
      const j=this.repo.get("SELECT * FROM jobs WHERE lane=? AND state IN('QUEUED','BACKOFF') AND due<=?"+backgroundFilter+" ORDER BY "+order+" LIMIT 1",...whereArgs,...orderArgs);
      if (!j) return null;
      this.claimCounts.set(lane,turn);
      const lease = randomUUID();
      this.repo.run(
        "UPDATE jobs SET state='RUNNING',lease=?,lease_until=?,updated_at=? WHERE id=? AND state IN('QUEUED','BACKOFF')",
        lease,
        now() + Math.ceil(this.timeoutMs / 1000) + 5,
        now(),
        j.id,
      );
      return { ...j, lease, payload: JSON.parse(j.payload) };
    });
  }
  /** Wake parked jobs whose precondition now holds; end parked jobs whose upstream job has ended. No auto-revival. */
  sweep() {
    this.lastSweep = now();
    try {
      if (this.lastSweep - this.lastLeaseRecovery >= 60) {
        this.repo.recoverRunningJobs(this.lastSweep);
        this.lastLeaseRecovery = this.lastSweep;
      }
      // This is a safety net for old/legacy parked rows. New capture work is
      // woken directly when its upstream data is saved, so a slower scan is safe.
      if (this.lastSweep - this.lastWakeSweep >= 120) {
        this.repo.wakeSatisfied();
        this.lastWakeSweep = this.lastSweep;
      }
    } catch (e) {
      this.repo.diagnostic("worker", null, `sweep: ${e.message}`);
    }
  }
  recent(list) {
    const cutoff = now() - 600;
    while (list.length && list[0] < cutoff) list.shift();
    return list.length;
  }
  tick() {
    if (this.stopped) return;
    if (!this.lastSweep || now() - this.lastSweep >= 60) this.sweep();
    if(!this.lastHeartbeat || now()-this.lastHeartbeat>=15){this.lastHeartbeat=now();this.repo.set('workerHealth',{...this.repo.setting('workerHealth',{}),heartbeatAt:now(),completed10m:this.recent(this.completedAt),failed10m:this.recent(this.failedAt)});}
    for (const [lane, limit] of Object.entries(this.limits)) {
      while ((this.running.get(lane) ?? 0) < limit) {
        const j = this.claim(lane);
        if (!j) break;
        this.running.set(lane, (this.running.get(lane) ?? 0) + 1);
        void this.execute(j).finally(() => {
          this.running.set(lane, this.running.get(lane) - 1);
          this.tick();
        });
      }
    }
    const active = [...this.running.values()].some((count) => count > 0);
    this.scheduleTick(active ? 500 : 1000);
  }
  async execute(j) {
    let timer,abortListener;
    const controller = new AbortController();
    this.controllers.add(controller);
    const guard = () =>
      !controller.signal.aborted && this.repo.db?.open!==false &&
      this.repo.current(j.chain, j.address, j.claim_version) &&
      !!this.repo.get(
        "SELECT 1 FROM jobs WHERE id=? AND lease=? AND state='RUNNING'",
        j.id,
        j.lease,
      );
    const ctx = {
      job: j,
      signal: controller.signal,
      guard,
      checkpoint: (payload) => {
        if (!guard()) throw Error("任务版本已失效");
        this.repo.run(
          "UPDATE jobs SET payload=? WHERE id=? AND lease=? AND state='RUNNING'",
          JSON.stringify(payload),
          j.id,
          j.lease,
        );
      },
    };
    try {
      if (!guard()) {
        this.repo.run(
          "UPDATE jobs SET state='INVALIDATED',lease=NULL,lease_until=NULL WHERE id=? AND lease=?",
          j.id,
          j.lease,
        );
        return;
      }
      const outcome = await Promise.race([
        Promise.resolve().then(() => this.handlers[j.lane](ctx)),
        new Promise((_,reject)=>{abortListener=()=>reject(controller.signal.reason??Error("Task cancelled"));controller.signal.addEventListener("abort",abortListener,{once:true});}),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error=new RetryError("请求超时，结果已失效",30);
            controller.abort(error);
            reject(error);
          }, this.timeoutMs);
        }),
      ]);
      if (!guard()) return;
      this.completedAt.push(now());
      if (outcome?.again) {
        const currentPayload = JSON.parse(this.repo.get('SELECT payload FROM jobs WHERE id=? AND lease=?', j.id, j.lease)?.payload || '{}');
        const nextPayload = { ...currentPayload, ...(outcome?.payload ?? {}) };
        this.repo.run(
          "UPDATE jobs SET state='QUEUED',payload=?,due=?,attempts=0,wait=NULL,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND lease=?",
          JSON.stringify(nextPayload),
          now() + outcome.again,
          now(),
          j.id,
          j.lease,
        );
      } else
        this.repo.run(
          "UPDATE jobs SET state='DONE',attempts=0,wait=NULL,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND lease=?",
          now(),
          j.id,
          j.lease,
        );
    } catch (e) {
      controller.abort();
      if(this.closing||this.repo.db?.open===false)return;
      const row = this.repo.get(
        "SELECT * FROM jobs WHERE id=? AND lease=?",
        j.id,
        j.lease,
      );
      if (!row) return;
      if (e instanceof WaitError || (e?.wait && e.permanent !== true)) {
        // Waiting for a precondition is not a failure: park without counting an attempt.
        this.repo.run(
          "UPDATE jobs SET state='PARKED',wait=?,lease=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease=?",
          String(e.wait),
          String(e.message).slice(0, 500),
          now(),
          j.id,
          j.lease,
        );
        return;
      }
      
      if (e?.deferred) {
        this.repo.run(
          "UPDATE jobs SET state='BACKOFF',wait=NULL,due=?,lease=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease=?",
          now() + Math.min(RETRY_MAX_DELAY_SEC, Math.max(1, Number(e.delay) || 1)),
          String(e.message).slice(0, 500), now(), j.id, j.lease,
        );
        return;
      }
      if (e?.noData) {
        const payload = JSON.parse(row.payload || '{}');
        // No-data means the provider answered with nothing usable; park now.
        // Rate-limit pauses still use DeferredError above and keep waiting.
        if (e.finalState !== "DONE") {
          payload.noDataRetries = Number(payload.noDataRetries || 0) + 1;
          payload.failureAttempts = Number(payload.failureAttempts || 0);
        }
        const state = e.finalState === "DONE" ? "DONE" : "PARKED";
        this.repo.run(
          "UPDATE jobs SET state=?,wait=?,attempts=attempts+1,due=?,payload=?,lease=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease=?",
          state,
          state === "DONE" ? null : "nodata",
          now(),
          JSON.stringify(payload),
          String(e.message).slice(0, 500),
          now(),
          j.id,
          j.lease,
        );
        this.repo.diagnostic(
          "job_failure",
          `${j.chain}:${j.address}`,
          `${j.lane}: ${e.message}${state === 'PARKED' ? '（无K线数据，已挂起）' : '（任务完成）'}`,
        );
        return;
      }
      this.failedAt.push(now());
      const capped = LANE_MAX_ATTEMPTS[j.lane];
      const retryHint = Number(e.delay ?? (Number(e.retryAfterMs) > 0 ? Math.ceil(e.retryAfterMs / 1000) : 0));
      const delay = capped
        ? Math.max(retryHint, LIMITED_LANE_DELAYS_SEC[Math.min(row.attempts, LIMITED_LANE_DELAYS_SEC.length - 1)])
        : retryDelay(row.attempts, retryHint);
      const payload=JSON.parse(row.payload||'{}');
      const manual=typeof payload.manualBatchId==='string'&&payload.manual===true;
      const failureAttempts=Number(payload.failureAttempts ?? (manual ? payload.manualAttempts : undefined) ?? row.attempts)+1;
      const retryable=isTransientMarketError(e);
      const exhausted=retryable&&failureAttempts>=RETRY_MAX_ATTEMPTS;
      if(retryable){payload.failureAttempts=failureAttempts;if(manual)payload.manualAttempts=failureAttempts;}
      this.repo.run(
        "UPDATE jobs SET state=?,wait=?,attempts=attempts+1,due=?,payload=?,lease=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease=?",
        !retryable ? "FAILED" : exhausted ? "PARKED" : "BACKOFF",
        // A network failure keeps an earlier "no data" mark so the next miss still ends the job.
        exhausted ? "limit" : row.wait === "nodata" ? "nodata" : null,
        now() + delay,
        JSON.stringify(payload),
        String(e.message).slice(0, 500),
        now(),
        j.id,
        j.lease,
      );
      this.repo.diagnostic(
        "job_failure",
        `${j.chain}:${j.address}`,
        `${j.lane}: ${e.message}${exhausted ? `（已尝试 ${RETRY_MAX_ATTEMPTS} 次，停止重试）` : retryable ? `（第 ${failureAttempts}/${RETRY_MAX_ATTEMPTS} 次，稍后重试）` : "（非临时错误，本项结束）"}`,
      );
    } finally {
      clearTimeout(timer);
      if(abortListener)controller.signal.removeEventListener('abort',abortListener);this.controllers.delete(controller);
      if(this.repo.db?.open!==false&&!this.closing)this.repo.set('workerHealth',{...this.repo.setting('workerHealth',{}),lastFinishedAt:now()});
    }
  }
  stop() {
    this.closing=true;
    this.stopped = true;
    for(const controller of this.controllers)controller.abort(Error("Application stopping"));
    clearTimeout(this.timer);
  }
}
