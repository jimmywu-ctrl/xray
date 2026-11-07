import { normalize, canonicalChain, now, CAPTURE_REFRESH_INTERVAL_SEC } from "../domain/rules.mjs";
import {resumeAutomaticAfterManual} from './manual-repair-resume.mjs';
import { performance } from "node:perf_hooks";
export class IngestionService {
  constructor(repo, changed = () => {}) {
    this.repo = repo;
    this.changed = changed;
  }
  ingest(input) {
    const started = performance.now();
    const e = { ...input };
    e.source = e.source ?? (e.group?.startsWith("tg:") ? "telegram" : "wechat");
    e.channel = String(e.channel ?? e.group ?? "");
    e.message = String(e.message ?? e.sourceId ?? "");
    e.kind = e.kind ?? e.messageEvent ?? "create";
    e.at = Number(e.at ?? e.time);
    e.revision = Number(
      e.revision ?? e.messageRevision ?? Math.floor(e.at * 1000),
    );
    e.addresses = e.addresses ?? e.addrs ?? [];
    e.sender = e.sender ?? "未知";
    e.senderKey = `${e.source}:${e.senderId ?? `${e.channel}:name:${e.sender}`}`;
    e.chain = canonicalChain(e.chain ?? e.chainHint);
    e.bot = !!e.isBot;
    if (
      !["telegram", "wechat"].includes(e.source) ||
      !e.channel ||
      !e.message ||
      !Number.isSafeInteger(e.revision) ||
      !Number.isFinite(e.at) ||
      e.at <= 0 ||
      e.at > now() + 30 ||
      !["create", "edit", "delete", "retract"].includes(e.kind)
    )
      throw Error("消息身份、时间或类型无效");
    const keys = new Set();
    const addedKeys = new Set();
    let newAddresses=false;
    const result = this.repo.transaction(() => {
      const inserted = this.repo.run(
        "INSERT OR IGNORE INTO events(source,channel,message,revision,kind,payload,received_at) VALUES(?,?,?,?,?,?,?)",
        e.source,
        e.channel,
        e.message,
        e.revision,
        e.kind,
        JSON.stringify(e),
        now(),
      );
      if (!inserted.changes) return "duplicate";
      const prior = this.repo.get(
        "SELECT * FROM messages WHERE source=? AND channel=? AND message=?",
        e.source,
        e.channel,
        e.message,
      );
      if (
        prior &&
        (e.revision < prior.revision ||
          (e.revision === prior.revision &&
            (e.kind === "create" || !prior.active)))
      )
        return "stale";
      const old = this.repo.all(
        "SELECT * FROM mentions WHERE source=? AND channel=? AND message=?",
        e.source,
        e.channel,
        e.message,
      );
      for (const m of old) keys.add(JSON.stringify([m.chain, m.address]));
      const active = !["delete", "retract"].includes(e.kind);
      newAddresses=active&&e.addresses.some(a=>!old.some(m=>m.active&&m.address===normalize(/^0x/i.test(a)?e.chain:"sol",a)));
      this.repo.run(
        "INSERT INTO messages VALUES(?,?,?,?,?,?) ON CONFLICT(source,channel,message) DO UPDATE SET revision=excluded.revision,active=excluded.active,payload=excluded.payload",
        e.source,
        e.channel,
        e.message,
        e.revision,
        active ? 1 : 0,
        JSON.stringify(e),
      );
      this.repo.run(
        "UPDATE mentions SET active=0 WHERE source=? AND channel=? AND message=?",
        e.source,
        e.channel,
        e.message,
      );
      if (active)
        for (const raw of [...new Set(e.addresses)]) {
          let chain = /^0x/i.test(raw) ? e.chain : "sol";
          const rawAddress = normalize(chain, raw);
          let address = rawAddress;
          const visited = new Set();
          for (;;) {
            if (visited.has(address) || visited.size >= 32) throw Error('CA 修正记录存在循环或过长');
            visited.add(address);
            const corrected = this.repo.setting(`caCorrection:${chain}:${address}`, null);
            if (!corrected) break;
            address = corrected;
          }
          if (chain === "?") {
            const known = [
              ...new Set(
                old
                  .filter((m) => m.address === address && m.chain !== "?")
                  .map((m) => m.chain),
              ),
            ];
            if (known.length === 1) chain = known[0];
          }
          const previous = old.find(
            (m) => m.address === address && m.chain === chain,
          );
          if (!previous?.active) addedKeys.add(JSON.stringify([chain, address]));
          const at =
            e.kind === "edit" && !previous
              ? Math.floor(e.revision / 1000)
              : (previous?.at ?? e.at);
          this.repo.run(
            "INSERT INTO mentions(source,channel,message,chain,address,sender_key,sender,at,bot,active) VALUES(?,?,?,?,?,?,?,?,?,1) ON CONFLICT(source,channel,message,chain,address) DO UPDATE SET sender_key=excluded.sender_key,sender=excluded.sender,bot=excluded.bot,active=1",
            e.source,
            e.channel,
            e.message,
            chain,
            address,
            e.senderKey,
            e.sender,
            at,
            e.bot ? 1 : 0,
          );
          this.repo.run(
            "INSERT INTO tokens(chain,address,last_call) VALUES(?,?,?) ON CONFLICT(chain,address) DO NOTHING",
            chain,
            address,
            0,
          );
          keys.add(JSON.stringify([chain, address]));
        }
      for (const key of keys) {
        const [chain,address]=JSON.parse(key), previous=this.repo.claim(chain,address);
        if (active && !e.bot && ["?", "sol", "eth", "bsc", "base", "monad", "robinhood", "arc"].includes(chain)) {
          const unknown = this.repo.get("SELECT metadata FROM tokens WHERE chain=? AND address=?", chain, address);
          if (unknown) {
            const metadata = JSON.parse(unknown.metadata || "{}");
            if (metadata.autoDisposition === "unlisted") {
              delete metadata.autoDisposition;
              delete metadata.autoDispositionAt;
              delete metadata.autoDispositionReason;
              delete metadata.autoDispositionEvidence;
              delete metadata.autoWalletAudit;
              const fallback = metadata.chainResolutionFallback || {};
              metadata.chainResolutionFallback = { ...fallback, complete: false, attempts: 0, retryAt: now() };
              this.repo.run("UPDATE tokens SET metadata=? WHERE chain=? AND address=?", JSON.stringify(metadata), chain, address);
              this.repo.run("UPDATE jobs SET state='QUEUED',wait=NULL,attempts=0,due=?,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE lane='capture' AND chain=? AND address=? AND wait='manual_wallet'", now(), now(), chain, address);
              this.repo.diagnostic("token_auto_wallet_reopened", `${chain}:${address}`, "已归档地址再次收到新喊单，已恢复代币核对");
            }
          }
        }
        this.repo.run(
          "UPDATE tokens SET last_call=COALESCE((SELECT MAX(at) FROM mentions WHERE chain=? AND address=? AND active=1 AND bot=0),0) WHERE chain=? AND address=?",
          chain,address,chain,address,
        );
        const disposition = JSON.parse(this.repo.get('SELECT metadata FROM tokens WHERE chain=? AND address=?',chain,address)?.metadata || '{}');
        const confirmedWallet = disposition.manualDisposition === 'wallet' || disposition.autoDisposition === 'wallet';
        this.reconcile(chain,address,{skipCapture:confirmedWallet});
        if (confirmedWallet) continue;
        // Keep one capture job and preserve its next incremental history checkpoint.
        if(active&&e.kind==='create'&&!e.bot&&previous?.active&&e.at>previous.at&&this.repo.claim(chain,address)?.version===previous.version){
          const lastCall=this.repo.get('SELECT last_call FROM tokens WHERE chain=? AND address=?',chain,address)?.last_call??e.at;
          const capture=this.repo.get('SELECT id,state,payload,wait,due FROM jobs WHERE lane=? AND chain=? AND address=? AND claim_version=?','capture',chain,address,previous.version);
          const payload=capture?.payload?JSON.parse(capture.payload):{};
          if(capture?.wait==='manual_stop'){
            resumeAutomaticAfterManual(this.repo);
            delete payload.manual;delete payload.manualBatchId;delete payload.manualAttempts;
            payload.failureAttempts=0;
          }
          if(capture?.state==='BACKOFF'||(capture?.state==='PARKED'&&['limit','nodata'].includes(capture.wait)))continue;
          const hasBaseline=!!this.repo.get('SELECT baseline FROM price_results WHERE chain=? AND address=? AND claim_version=?',chain,address,previous.version)?.baseline;
          const waiting=capture?.state==='PARKED'&&['ave_api_key','baseline','verify','chain','manual_review'].includes(capture.wait);
          const nextPayload={...payload,stage:hasBaseline?'history':'baseline'};
          if (hasBaseline && !payload.manualBatchId) nextPayload.refresh = true;
          else delete nextPayload.refresh;
          const nextDue=(payload.manualBatchId||chain==='?'||!hasBaseline)?now():Math.min(capture?.due>now()?capture.due:now()+CAPTURE_REFRESH_INTERVAL_SEC,now()+CAPTURE_REFRESH_INTERVAL_SEC);
          if(waiting)continue;
          if(capture?.state==='RUNNING'){
            this.repo.run("UPDATE jobs SET payload=?,due=?,updated_at=? WHERE id=?",JSON.stringify(nextPayload),nextDue,now(),capture.id);
          }else if(capture){
            this.repo.run("UPDATE jobs SET payload=?,state='QUEUED',wait=NULL,attempts=0,due=?,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=?",JSON.stringify(nextPayload),nextDue,now(),capture.id);
          }else this.repo.enqueue('capture',chain,address,previous.version,nextPayload,1,nextDue);
        }
      }
      return "applied";
    });
    if (result === "applied") {
      const ingestedAtMs = Date.now();
      if (e.kind === "create" && !e.bot && !e.backfill && e.addresses.length > 0) {
        const traceId = JSON.stringify([e.source, e.channel, e.message]);
        this.repo.diagnostic("message_latency", traceId, JSON.stringify({
          traceId, source: e.source, sourceAtMs: Math.floor(e.at) * 1000, sourceTimeResolutionMs: 1000,
          detectedAtMs: e.detectedAtMs, ingestedAtMs, detectedToIngestMs: ingestedAtMs - e.detectedAtMs, displayedAtMs: null,
        }));
      }
      this.repo.project({ mentionsChanged: true });
      const prefetchKeys = ['create', 'edit'].includes(e.kind) && !e.bot && !e.backfill
        ? [...addedKeys].map((key) => JSON.parse(key)).map(([chain, address]) => `${chain}:${address}`)
        : [];
      this.changed(keys.size > 0 && !e.backfill && !['delete', 'retract'].includes(e.kind) ? { urgent: true, wake: newAddresses&&!e.bot&&(e.kind==='edit'?e.revision/1000:e.at)>=now()-30, prefetchKeys } : undefined);
    }
    this.repo.recordPerformance("ingest", performance.now() - started, keys.size);
    return result;
  }
  reconcile(chain, address, options = {}) {
    const winner = this.repo.get(
      "SELECT * FROM mentions WHERE chain=? AND address=? AND active=1 AND bot=0 ORDER BY at,source,channel,message,id LIMIT 1",
      chain,
      address,
    );
    const old = this.repo.claim(chain, address);
    if ((old?.owner ?? null) === (winner?.id ?? null)) return;
    const version = (old?.version ?? 0) + 1;
    this.repo.run(
      "UPDATE jobs SET state='INVALIDATED',lease=NULL,lease_until=NULL WHERE chain=? AND address=? AND state IN('QUEUED','RUNNING','BACKOFF','PARKED')",
      chain,
      address,
    );
    this.repo.run(
      "INSERT INTO claims VALUES(?,?,?,?,?,?) ON CONFLICT(chain,address) DO UPDATE SET owner=excluded.owner,version=excluded.version,at=excluded.at,active=excluded.active",
      chain,
      address,
      winner?.id ?? null,
      version,
      winner?.at ?? null,
      winner ? 1 : 0,
    );
    this.repo.run(
      "INSERT INTO results(chain,address,claim_version,status) VALUES(?,?,?,'pending_token') ON CONFLICT(chain,address) DO UPDATE SET claim_version=excluded.claim_version,baseline_id=NULL,formal_peak_id=NULL,reference_peak_id=NULL,low_id=NULL,status='pending_token'",
      chain,
      address,
      version,
    );
    if (winner && !options.skipCapture) {
      this.repo.enqueue("capture", chain, address, version, {}, 1);
    }
    this.repo.diagnostic(
      "attribution",
      `${chain}:${address}`,
      `owner ${old?.owner ?? "none"} -> ${winner?.id ?? "none"}; version ${version}`,
    );
  }
  resolveChain(address, chain, options = {}) {
    const sourceChain = options.sourceChain || "?";
    if (chain === "?" || chain === sourceChain) return;
    this.repo.transaction(() => {
      const rows = this.repo.all(
        "SELECT * FROM mentions WHERE chain=? AND address=?",
        sourceChain,
        address,
      );
      if (!rows.length) return;
      this.repo.run(
        "INSERT OR IGNORE INTO tokens(chain,address) VALUES(?,?)",
        chain,
        address,
      );
      const unknownToken = this.repo.get("SELECT metadata FROM tokens WHERE chain=? AND address=?", sourceChain, address);
      const unknownMetadata = JSON.parse(unknownToken?.metadata || "{}");
      const token = this.repo.get("SELECT metadata FROM tokens WHERE chain=? AND address=?", chain, address);
      if (token) {
        const metadata = JSON.parse(token.metadata || "{}");
        const displayChainMatches = !unknownMetadata.dexDisplayLookup?.chain || canonicalChain(unknownMetadata.dexDisplayLookup.chain) === canonicalChain(chain);
        if (displayChainMatches) {
          for (const field of ["symbol", "name", "logo"]) if (!metadata[field] && unknownMetadata[field]) metadata[field] = unknownMetadata[field];
          metadata.sources = { ...(unknownMetadata.sources || {}), ...(metadata.sources || {}) };
          if (!metadata.logoLookup && unknownMetadata.logoLookup) metadata.logoLookup = unknownMetadata.logoLookup;
        }
        if (unknownMetadata.aveChainLookup) metadata.aveChainLookup = unknownMetadata.aveChainLookup;
        if (unknownMetadata.chainResolutionFallback) metadata.chainResolutionFallback = unknownMetadata.chainResolutionFallback;
        this.repo.run("UPDATE tokens SET metadata=? WHERE chain=? AND address=?", JSON.stringify(metadata), chain, address);
      }
      for (const r of rows) {
        this.repo.run(
          "INSERT OR IGNORE INTO mentions(source,channel,message,chain,address,sender_key,sender,at,bot,active) VALUES(?,?,?,?,?,?,?,?,?,?)",
          r.source,
          r.channel,
          r.message,
          chain,
          r.address,
          r.sender_key,
          r.sender,
          r.at,
          r.bot,
          r.active,
        );
      }
      this.repo.run(
        "UPDATE mentions SET active=0 WHERE chain=? AND address=?",
        sourceChain,
        address,
      );
      this.repo.run("UPDATE tokens SET last_call=0 WHERE chain=? AND address=?", sourceChain, address);
      this.repo.run(
        "UPDATE tokens SET last_call=COALESCE((SELECT MAX(at) FROM mentions WHERE chain=? AND address=? AND active=1),0) WHERE chain=? AND address=?",
        chain,
        address,
        chain,
        address,
      );
      this.reconcile(sourceChain, address);
      this.reconcile(chain, address, { skipCapture: options.skipCapture === true });
      if (options.manualBatchId) {
        const claim = this.repo.claim(chain, address);
        if (claim?.active) {
          const result = this.repo.get('SELECT baseline FROM price_results WHERE chain=? AND address=? AND claim_version=?', chain, address, claim.version);
          const payload = { stage: result?.baseline ? 'history' : 'baseline', manual: true, manualBatchId: options.manualBatchId, manualAttempts: 0 };
          const job = this.repo.get("SELECT id FROM jobs WHERE lane='capture' AND chain=? AND address=? AND claim_version=? AND state IN('QUEUED','BACKOFF','RUNNING','PARKED') ORDER BY id DESC LIMIT 1", chain, address, claim.version);
          if (job) this.repo.run("UPDATE jobs SET payload=?,due=?,priority=MIN(priority,5),wait=NULL,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=?", JSON.stringify(payload), now(), now(), job.id);
          else this.repo.enqueue('capture', chain, address, claim.version, payload, 5, now());
          this.repo.diagnostic('manual_repair', `${chain}:${address}`, '未知链确认后已将手动补查任务接续到新链归属');
        }
      }
    });
    this.repo.project({ mentionsChanged: true });
    this.changed({ urgent: true, prefetchKeys: [`${chain}:${address}`] });
  }
  ignoreUnknownChain(address, reason = "未能确认所属链；保留原始消息记录，不作为代币处理", sourceChain = "?") {
    const active = this.repo.get(
      "SELECT 1 FROM mentions WHERE chain=? AND address=? AND active=1 LIMIT 1",
      sourceChain, address,
    );
    if (!active) return false;
    this.repo.transaction(() => {
      // Preserve source history, but don't keep an unidentifiable address as an active token.
      this.repo.run("UPDATE mentions SET active=0 WHERE chain=? AND address=?", sourceChain, address);
      this.repo.run("UPDATE tokens SET last_call=0 WHERE chain=? AND address=?", sourceChain, address);
      this.reconcile(sourceChain, address);
    });
    this.repo.project({ mentionsChanged: true });
    this.repo.diagnostic("token_ignored_unknown_chain", sourceChain + ":" + address, reason);
    this.changed();
    return true;
  }
  archiveUnknownCandidate(address) {
    const row = this.repo.get(`
      SELECT t.metadata FROM tokens t JOIN claims c ON c.chain=t.chain AND c.address=t.address
      WHERE t.chain='?' AND t.address=? AND t.blocked=0 AND t.verified=0 AND c.active=1
        AND COALESCE(json_extract(t.metadata,'$.manualDisposition'),'')<>'wallet'
        AND COALESCE(json_extract(t.metadata,'$.autoDisposition'),'') NOT IN ('wallet','unlisted')
      ORDER BY c.at DESC LIMIT 1
    `, address);
    if (!row) return false;
    const metadata = JSON.parse(row.metadata || "{}");
    const fallback = metadata.chainResolutionFallback || {};
    const audit = metadata.autoWalletAudit || {};
    const walletCheckFinished = audit.status === "unknown" && audit.reason === "所查网络都没有该地址的发起交易记录，不能仅凭无合约代码判定为钱包";
    const noMarketListing = fallback.complete === true && fallback.avePage?.status === "no_match" && fallback.dex?.status === "no_match";
    if (!walletCheckFinished || !noMarketListing) return false;
    const at = now();
    const reason = "AVE 网页与 Dex 均未发现代币，所查 EVM 网络也没有合约代码、发起交易或原生币余额；归档为‘无代币命中／疑似钱包’，不代表已确认钱包。";
    metadata.autoDisposition = "unlisted";
    metadata.autoDispositionAt = at;
    metadata.autoDispositionReason = reason;
    metadata.autoDispositionEvidence = {
      avePage: fallback.avePage,
      dex: fallback.dex,
      walletAudit: { status: audit.status, reason: audit.reason, checkedAt: audit.checkedAt },
      archivedAt: at,
    };
    this.repo.transaction(() => {
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain='?' AND address=?", JSON.stringify(metadata), address);
      this.repo.run("UPDATE jobs SET state='PARKED',wait='manual_unlisted',lease=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE lane='capture' AND chain='?' AND address=? AND state NOT IN('DONE','INVALIDATED')", reason, at, address);
    });
    this.repo.diagnostic("token_auto_unlisted", `?:${address}`, reason);
    this.changed();
    return true;
  }
  markUnknownWallet(address, options = {}) {
    if (!/^0x[\da-f]{40}$/i.test(address) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
      throw Error("地址格式无效");
    const token = this.repo.get(`SELECT t.chain,t.metadata FROM tokens t JOIN claims c ON c.chain=t.chain AND c.address=t.address
      WHERE t.address=? AND t.blocked=0 AND t.verified=0 AND c.active=1
      ORDER BY CASE WHEN t.chain='?' THEN 0 ELSE 1 END,c.at DESC LIMIT 1`, address);
    if (!token) throw Error("该地址已不在待确认列表中");
    const chain = token.chain;
    const automatic = options.automatic === true;
    if (automatic && !["?", "sol", "eth", "bsc", "base", "monad", "robinhood", "arc"].includes(chain)) throw Error("该链尚不支持自动钱包复核");
    const active = this.repo.get("SELECT 1 FROM mentions WHERE chain=? AND address=? AND active=1 LIMIT 1", chain, address);
    if (!active) throw Error("该地址已不在待确认列表中");
    const metadata = JSON.parse(token.metadata || "{}");
    if (automatic) {
      metadata.autoDisposition = "wallet";
      metadata.autoDispositionAt = now();
      const evidence = options.evidence || null;
      const reason = typeof evidence?.reason === "string" ? evidence.reason : "已确认该地址是普通钱包地址";
      metadata.autoWalletAudit = { status: "wallet", engineVersion: 2, reason, checkedAt: now(), evidence };
    } else {
      metadata.manualDisposition = "wallet";
      metadata.manualDispositionAt = now();
    }
    this.repo.transaction(() => {
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain=? AND address=?", JSON.stringify(metadata), chain, address);
      const reason = automatic ? "自动复核确认是钱包地址；不作为代币处理" : "已手动标记为普通钱包地址；不作为代币处理";
      this.repo.run("UPDATE jobs SET state='PARKED',wait='manual_wallet',lease=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE lane='capture' AND chain=? AND address=? AND state NOT IN('DONE','INVALIDATED')", reason, now(), chain, address);
    });
    this.repo.project();
    this.repo.diagnostic(automatic ? "token_auto_wallet" : "token_manual_wallet", `${chain}:${address}`, automatic ? "自动复核确认是普通钱包地址；保留原始消息，不纳入代币统计" : "已手动确认是普通钱包地址；保留原始消息，不纳入代币统计");
    this.changed();
    return { ok: true };
  }
  restoreUnknownWallet(address) {
    const token = this.repo.get(`SELECT chain,metadata FROM tokens
      WHERE address=? AND blocked=0 AND verified=0
        AND (json_extract(metadata,'$.manualDisposition')='wallet' OR json_extract(metadata,'$.autoDisposition') IN ('wallet','unlisted'))
      ORDER BY CASE WHEN chain='?' THEN 0 ELSE 1 END LIMIT 1`, address);
    if (!token) throw Error("地址不存在");
    const chain = token.chain;
    const metadata = JSON.parse(token.metadata || "{}");
    if (metadata.manualDisposition !== "wallet" && !["wallet", "unlisted"].includes(metadata.autoDisposition)) throw Error("该地址没有被归档");
    delete metadata.manualDisposition;
    delete metadata.manualDispositionAt;
    delete metadata.autoDisposition;
    delete metadata.autoDispositionAt;
    delete metadata.autoDispositionReason;
    delete metadata.autoDispositionEvidence;
    delete metadata.autoWalletAudit;
    const fallback = metadata.chainResolutionFallback || {};
    metadata.chainResolutionFallback = { ...fallback, complete: false, attempts: 0, retryAt: now() };
    this.repo.transaction(() => {
      this.repo.run("UPDATE tokens SET metadata=? WHERE chain=? AND address=?", JSON.stringify(metadata), chain, address);
      this.repo.run("UPDATE jobs SET state='QUEUED',wait=NULL,due=?,attempts=0,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE lane='capture' AND chain=? AND address=? AND wait IN('manual_wallet','manual_unlisted')", now(), now(), chain, address);
    });
    this.repo.project();
    this.repo.diagnostic("token_manual_wallet_restored", `${chain}:${address}`, "撤销归档标记；重新进入链核对队列");
    this.changed();
    return { ok: true };
  }
}
