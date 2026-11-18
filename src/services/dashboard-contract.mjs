// Old presentation contract over the new repository. No legacy engine or tables.
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {resumeAutomaticAfterManual} from './manual-repair-resume.mjs';
import path from 'node:path';
import { now, median, compatible, canonicalChain, RECENT_WINDOW_SEC } from '../domain/rules.mjs';
import { DATA_DIR, KEYS_FILE, autoDetectDbDir } from '../adapters/config.ts';
import { isAveChainSlug } from '../domain/provider-chains.mjs';
import { acquisitionStatus } from './acquisition-status.mjs';
export class DashboardContract {
  constructor(repo, collectors, market, bridge, broadcast) {
    Object.assign(this, { repo, collectors, market, bridge, broadcast });
    this.groupNames = new Map();
    // Only batches created by this implementation are eligible for crash recovery.
    // Legacy activeRepairRun / market-audit settings are deliberately ignored.
    this.recoverManualRepairBatch();
  }
  manualRepairKey = 'manualRepairBatchV1';
  isWaitingRepair(row) {
    return row.state === 'PARKED' && ['ave_api_key','baseline','verify','chain'].includes(row.wait);
  }
  manualRepairRows(runId) {
    const batch=this.repo.setting(this.manualRepairKey,null);
    if(batch?.id===runId&&batch.status!=='running'&&Array.isArray(batch.rows))return batch.rows;
    return this.repo.all("SELECT j.id,j.chain,j.address,j.claim_version,j.payload,j.state,j.wait,j.attempts,j.due,j.last_error,j.updated_at,p.baseline,p.peak FROM jobs j LEFT JOIN price_results p ON p.chain=j.chain AND p.address=j.address AND p.claim_version=j.claim_version WHERE j.lane='capture' AND json_extract(j.payload,'$.manualBatchId')=? ORDER BY j.id", runId);
  }
  repairSnapshot() {
    resumeAutomaticAfterManual(this.repo);
    let batch=this.repo.setting(this.manualRepairKey,null);
    if(!batch?.id)return {running:false,queued:false,phase:'idle',phaseTotal:0,phaseCompleted:0,totalCalls:0,completedCalls:0,totalAth:0,completedAth:0,metadataTotal:0,metadataCompleted:0,runId:null,health:this.taskHealth()};
    const allRows=this.manualRepairRows(batch.id), activeStates=new Set(['QUEUED','BACKOFF','RUNNING']);
    // Keep unresolved addresses visible while their one chain check is running,
    // then exclude them from token-repair totals when that check ends unresolved.
    const rows=allRows.filter(r=>r.chain!=='?'||activeStates.has(r.state)), terminal=new Set(['DONE','FAILED','PARKED','INVALIDATED']);
    const isTerminal=row=>terminal.has(row.state)&&!this.isWaitingRepair(row);
    const hasValidPeak=(row)=>{try{const peak=JSON.parse(row.peak||'null');return Number.isFinite(Number(peak?.multiple))&&Number(peak.multiple)>0;}catch{return false;}};
    const done=rows.filter(r=>isTerminal(r)).length, running=rows.filter(r=>r.state==='RUNNING').length, queued=rows.filter(r=>['QUEUED','BACKOFF'].includes(r.state)).length;
    const completedCalls=rows.filter(r=>r.baseline||isTerminal(r)).length;
    const completedAth=rows.filter(r=>r.peak||isTerminal(r)).length;
    const waiting=rows.filter(r=>this.isWaitingRepair(r)).length;
    const active=running+queued+waiting>0;
    if(batch.status==='running'&&!active){batch={...batch,status:'complete',finishedAt:now(),rows:allRows};this.repo.set(this.manualRepairKey,batch);}
    const phaseRows=rows.filter(r=>!isTerminal(r));
    const history=phaseRows.some(r=>JSON.parse(r.payload||'{}').stage==='history');
    const stalled=rows.some(r=>r.state==='RUNNING'&&now()-Number(r.updated_at||now())>75);
    const retryCount=rows.filter(r=>r.state==='BACKOFF').length;
    const failed=rows.filter(r=>['FAILED','PARKED'].includes(r.state)&&!this.isWaitingRepair(r)).length;
    const noData=rows.filter(r=>r.state==='PARKED'&&r.wait==='nodata').length;
    const unresolvedChain=rows.filter(r=>r.state==='PARKED'&&r.wait==='chain').length;
    const waitingQuiet=rows.filter(r=>{const payload=JSON.parse(r.payload||'{}');return !payload.manualBatchId&&r.state==='QUEUED'&&payload.stage==='history'&&Number(r.due)>now();}).length;
    return {
      runId:batch.id,running:batch.status==='running'&&active,queued:batch.status==='running'&&queued>0,
      phase:batch.status==='running'?(waiting&&!running&&!queued?'waiting':stalled?'stalled':history?'ath':'baseline'):(batch.status==='complete'?'complete':batch.status),
      phaseTotal:rows.length,phaseCompleted:done,totalCalls:rows.length,completedCalls:completedCalls,
      totalAth:rows.length,completedAth,metadataTotal:0,metadataCompleted:0,
      startedAt:batch.startedAt,finishedAt:batch.finishedAt||null,lastResponseAt:rows.length?Math.max(...rows.map(r=>Number(r.updated_at)||0)):batch.startedAt,
      total:rows.length,done,remaining:Math.max(0,rows.length-done),waitingItems:waiting,runningItems:running,queuedItems:queued,retryingItems:retryCount,
      failedItems:failed,noDataItems:noData,unresolvedChainItems:unresolvedChain,obtainedPeak:rows.filter(hasValidPeak).length,missingAfterBatch:rows.filter(r=>isTerminal(r)&&!hasValidPeak(r)).length,waitingQuiet,skipped:Number(batch.skipped||0),
      lastError:stalled?'有查询超过执行时限；工作器会结束本次并按重试上限恢复':null,
      health:{state:stalled?'stalled':active?'running':'idle',label:stalled?'查询较慢':active?'正在处理手动补查':'采集任务空闲',running,queued:queued-retryCount,backoff:retryCount,failed:failed,noData,reason:stalled?'单项查询超过执行时限，将在最多 3 次后停止':''},
    };
  }
  startManualRepairBatch() {
    const current=this.repairSnapshot();
    if(current.running||current.queued)return {...current,accepted:false,message:'已有手动补查批次在处理'};
    const id=`manual-repair-${now()}-${Math.random().toString(36).slice(2,8)}`;
    const candidates=this.repo.all(`
      SELECT c.chain,c.address,c.version,c.at,t.last_call,p.baseline,p.peak,j.id job_id,j.state job_state,j.payload job_payload,j.due job_due
      FROM claims c JOIN tokens t USING(chain,address)
      LEFT JOIN price_results p ON p.chain=c.chain AND p.address=c.address AND p.claim_version=c.version
      LEFT JOIN jobs j ON j.lane='capture' AND j.chain=c.chain AND j.address=c.address AND j.claim_version=c.version
      WHERE c.active=1 AND t.blocked=0 AND t.verified=1 AND c.chain<>'?'
        AND (p.peak IS NULL OR CAST(json_extract(p.peak,'$.multiple') AS REAL)<=0 OR json_extract(p.peak,'$.multiple') IS NULL)
      ORDER BY c.at,c.chain,c.address`);
    const eligible=candidates.filter(r=>{
      const payload=JSON.parse(r.job_payload||'{}');
      return !['QUEUED','BACKOFF','RUNNING'].includes(r.job_state)||
        (r.job_state==='QUEUED'&&r.job_due>now()&&payload.stage==='history'&&!payload.manualBatchId);
    });
    const skipped=candidates.length-eligible.length;
    const created=[];
    this.repo.transaction(()=>{
      for(const r of eligible){
        const stage=r.baseline?'history':'baseline';
        // Batch repair is user-triggered: query immediately, regardless of
        // the automatic capture quiet window.
        const due=now();
        const payload={stage,manual:true,manualBatchId:id,manualAttempts:0};
        if(r.job_id){
          const changed=this.repo.run("UPDATE jobs SET payload=?,state='QUEUED',attempts=0,wait=NULL,due=?,lease=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND (state NOT IN('QUEUED','BACKOFF','RUNNING') OR (state='QUEUED' AND due>? AND json_extract(jobs.payload,'$.stage')='history' AND json_extract(jobs.payload,'$.manualBatchId') IS NULL))",JSON.stringify(payload),due,now(),r.job_id,now()).changes;
          if(changed)created.push(r);
        }else{
          this.repo.enqueue('capture',r.chain,r.address,r.version,payload,5,due);
          created.push(r);
        }
      }
      const batch={id,status:created.length?'running':'complete',startedAt:now(),finishedAt:created.length?null:now(),total:created.length,skipped,source:'manual-missing-only-v1'};
      this.repo.set(this.manualRepairKey,batch);
      this.repo.diagnostic('manual_repair',id,`手动补查已建立：${created.length} 个缺少喊后高点的已确认合约；跳过 ${skipped} 个已有活动任务`);
    });
    return {...this.repairSnapshot(),accepted:true,message:created.length?`已加入 ${created.length} 个缺失项`:'没有可补查的缺失项'};
  }
  stopManualRepairBatch() {
    const batch=this.repo.setting(this.manualRepairKey,null);
    if(!batch?.id||batch.status!=='running')return this.repairSnapshot();
    const ts=now();
    this.repo.run("UPDATE jobs SET state='PARKED',wait='manual_stop',lease=NULL,lease_until=NULL,last_error='用户停止了本轮手动补查',updated_at=? WHERE lane='capture' AND json_extract(payload,'$.manualBatchId')=? AND (state IN('QUEUED','BACKOFF','RUNNING') OR (state='PARKED' AND wait IN('ave_api_key','baseline','verify','chain')))",ts,batch.id);
    this.repo.set(this.manualRepairKey,{...batch,status:'stopped',finishedAt:ts});
    this.repo.diagnostic('manual_repair',batch.id,'用户停止了本轮手动补查；未完成项目已结束');
    return this.repairSnapshot();
  }
  recoverManualRepairBatch() {
    const batch=this.repo.setting(this.manualRepairKey,null);
    if(!batch?.id||batch.status!=='running')return;
    const interrupted=this.repo.all("SELECT id,payload,attempts,last_error FROM jobs WHERE lane='capture' AND json_extract(payload,'$.manualBatchId')=? AND state='FAILED' AND last_error LIKE '应用重启中断查询%'",batch.id);
    for(const row of interrupted){
      const payload=JSON.parse(row.payload||'{}'),tries=Number(payload.manualAttempts||0);
      if(tries>=3)continue;
      this.repo.run("UPDATE jobs SET state='BACKOFF',wait=NULL,due=?,last_error='应用重启中断；仅恢复本轮手动补查（有次数上限）',updated_at=? WHERE id=? AND state='FAILED'",now()+30,now(),row.id);
    }
    const active=this.manualRepairRows(batch.id).some(r=>['QUEUED','BACKOFF','RUNNING'].includes(r.state)||this.isWaitingRepair(r));
    if(!active)this.repo.set(this.manualRepairKey,{...batch,status:'complete',finishedAt:now()});
    else this.repo.diagnostic('manual_repair',batch.id,'仅恢复本轮手动补查中因应用重启而中断的项目；旧版批次未恢复');
  }
  auditSnapshot(limit=100,offset=0) {
    const repair=this.repairSnapshot();
    const batchRows=this.manualRepairRows(repair.runId),total=Number(repair.total||0),rows=batchRows.filter(r=>['FAILED','PARKED','INVALIDATED'].includes(r.state)).map(r=>({chain:r.chain,address:r.address,claimVersion:r.claim_version,state:r.state,wait:r.wait,statusLabel:r.state==='FAILED'?'查询失败，已结束':r.state==='INVALIDATED'?'喊单归属已变化，已跳过':r.wait==='chain'?'接口仍无法唯一确认所属链':r.wait==='limit'?'达到 3 次上限，已停止':r.wait==='manual_stop'?'本轮已手动停止':'接口未返回有效行情，本轮结束',stage:JSON.parse(r.payload||'{}').stage,attempts:Number(JSON.parse(r.payload||'{}').manualAttempts||0),reason:r.last_error||null,updatedAt:r.updated_at}));
    const baseline=batchRows.filter(r=>r.baseline).length;
    const peak=batchRows.filter(r=>r.peak).length;
    const global=this.repo.get("SELECT COUNT(*) total,SUM(CASE WHEN p.baseline IS NOT NULL THEN 1 ELSE 0 END) baseline,SUM(CASE WHEN CAST(json_extract(p.peak,'$.multiple') AS REAL)>0 THEN 1 ELSE 0 END) peak FROM claims c JOIN tokens t USING(chain,address) LEFT JOIN price_results p ON p.chain=c.chain AND p.address=c.address AND p.claim_version=c.version WHERE c.active=1 AND t.verified=1 AND t.blocked=0 AND c.chain<>'?'")||{};
    const logicalItems=repair.runId?total:Number(global.total||0),baseCount=repair.runId?baseline:Number(global.baseline||0),peakCount=repair.runId?peak:Number(global.peak||0);
    return {status:{run:repair.runId?{id:repair.runId,status:repair.running?'running':repair.phase}:null,outcomes:{callBaselines:{logicalItems,unresolved:Math.max(0,logicalItems-baseCount)},callAth:{logicalItems,unresolved:Math.max(0,logicalItems-peakCount)}}},items:rows.slice(Math.max(0,offset),Math.max(0,offset)+Math.max(1,limit)),total:rows.length,offset:Math.max(0,offset),limit:Math.max(1,limit),repair};
  }
  settings() {
    const s = this.repo.setting('monitor', {wechat:[],telegram:[]});
    return {groups:s.wechat,telegramGroups:s.telegram,senderFilters:this.repo.setting('senderFilters',{}),panel:this.repo.setting('panel',{})};
  }
  async groups(source='wechat') {
    const list = await this.collectors.groups(source), s=this.settings();
    return list.map(g=> {
      const id=g.peerId??g.username, channel=source==='telegram'?'tg:'+id:id;
      this.groupNames.set(channel,g.title??g.displayName??id);
      return {...g,watched:source==='telegram'?s.telegramGroups.some(x=>x.peerId===id):s.groups.includes(id)};
    });
  }
  rows(url) {
    const excluded = this.repo.setting('statsExclusions',[]);
    const source=url.searchParams.get('source'), group=url.searchParams.get('group'), hours=Number(url.searchParams.get('hours'))||0;
    const since = Math.max(0, Number(url.searchParams.get('since')) || (url.pathname === '/api/overview' ? now() - 24 * 3600 : 0));
    return this.repo.projection('rows',[]).filter(r=>(!source||source==='all'||r.source===source)&&(!group||r.channel===group)&&(!hours||r.at>=now()-hours*3600)&&r.at>=since).map(r=>({...this.withLive(r),excluded:excluded.includes(r.chain+':'+r.address)}));
  }
  /** Overlay quotes are memory-only (MarketService.live); fall back to the stored row when absent. */
  withLive(r) {
    const e=this.market?.liveQuote?.(r.chain,r.address);
    if(!e||e.version!==r.version||!['dex','ave'].includes(e.provider)||!e.quote)
      return {...r,quote:r.quote??null,receivedAt:r.receivedAt??r.quote?.receivedAt??null};
    const q=e.quote,logo=r.logo??(/^https?:\/\//i.test(q.logo??'')?q.logo:undefined);
    return {...r,quote:q,receivedAt:e.receivedAt,symbol:r.symbol??q.symbol,name:r.name??q.name,logo,liveHigh:e.high};
  }
  isApproximateBaseline(r) {
    const baseline = r.priceBaseline ?? r.baseline;
    return Boolean(baseline?.approximate ?? r.priceApproximate);
  }
  multiple(r, includeApprox=false) {
    if (!includeApprox && (
      this.isApproximateBaseline(r) ||
      r.pricePeak?.origin === 'observed-live-high-fallback'
    )) return null;
    return r.priceMultiple ?? null;
  }
  call(r, include=false) {
    const p=r.pricePeak,storedBase=r.priceBaseline,b=storedBase,x=this.multiple(r,include), eligible=x!=null&&!r.excluded;
    const job=this.repo.get("SELECT state,wait,due,payload,last_error FROM jobs WHERE lane='capture' AND chain=? AND address=? AND claim_version=?",r.chain,r.address,r.version)||{};
    const acquisition=acquisitionStatus(job);
    const reason=!r.verified?'待确认地址':!b?'缺少首喊价格基准 · '+acquisition.label:!p?acquisition.label:x==null?(p?.origin==='observed-live-high-fallback'?'只有已观察到的实时高点，未计入正式统计':this.isApproximateBaseline(r)?'使用开池后参考基准，未计入正式统计':'估算参考，未计入正式统计'):null;
    return {id:r.version,address:r.address,sender:r.sender,senderKey:r.senderKey,source:r.source,ts:r.at,group:r.channel,grp:r.channel,key_chain:r.chain,chain:r.chain,symbol:r.symbol,logo:r.logo,n:1,
      base_mc:b?.mc??null,base_price:b?.price??null,baseMc:b?.mc??null,basePrice:b?.price??null,baseMcSource:b?.provider,baseMcBasis:b?.basis,baseQuoteAt:b?.at,quote_at:b?.at,baseReceivedAt:b?.receivedAt,mc_precision:b?.precision,mcPrecision:b?.precision,pricePrecision:b?.precision,approx:!!(r.priceApproximate||b?.approximate),
      athMc:p?.mc??null,athAt:p?.at??null,athProvider:p?.provider,peakPrice:p?.price??null,peakMc:p?.mc??null,peak_at:p?.at??null,peakAt:p?.at??null,peakSource:p?.provider,peakX:x,peakX24:x,performanceEligible:eligible,counted:eligible,statsIncluded:eligible,mature:!!p,excluded:r.excluded,ineligibleReason:reason,
      observedPeakX:r.observedPeak?.multiple??null,observedPeakAt:r.observedPeak?.at??null,historyThrough:p?.coverage?.to??null,acquisition,
      nowMc:r.quote?.mc??null,nowLiq:r.quote?.liq??null,nowX:b&&r.quote&&compatible(b,r.quote)?r.quote.mc/b.mc:null,
      referencePeakX:r.referenceMultiple,referencePeakMc:r.referencePeak?.mc,referencePeakAt:r.referencePeak?.at,lowestObservedMc:r.lowest?.mc,lowestObservedAt:r.lowest?.at,maxObservedLossPct:r.maxObservedLossPct,lowestObservedEstimated:!!r.lowest?.estimated,
      sampleCount:this.repo.get('SELECT count(*) n FROM evidence WHERE chain=? AND address=? AND claim_version=? AND accepted=1 AND revoked=0',r.chain,r.address,r.version).n};
  }
  stats(rows, include=false, winX=2, minSamples=1) {
    const buckets=new Map();
    for(const r of rows){let b=buckets.get(r.senderKey);if(!b){b={sender:r.sender,senderKey:r.senderKey,source:r.source,totalCalls:0,baselineCalls:0,missingBaselineCalls:0,pendingAddresses:0,expiredBaselines:0,missingPeakCalls:0,approximateCalls:0,inProgressCalls:0,insufficientSampleCalls:0,values:[],best:null};buckets.set(r.senderKey,b);}b.totalCalls++;b.baselineCalls+=!!(r.priceBaseline??r.baseline);b.missingBaselineCalls+=!(r.priceBaseline??r.baseline);b.pendingAddresses+=!r.verified;b.approximateCalls+=!!(r.priceBaseline??r.baseline)?.approximate||r.pricePeak?.origin==='observed-live-high-fallback';b.missingPeakCalls+=!r.pricePeak&&!r.formalPeak&&!r.referencePeak;
      const x=this.multiple(r,include);if(x!=null&&!r.excluded){b.values.push(x);if(!b.best||x>b.best.x)b.best={symbol:r.symbol??r.address.slice(0,8),logo:r.logo,chain:r.chain,address:r.address,x};}
    }
    return [...buckets.values()].map(({values,...b})=>({...b,calls:values.length,winRate:values.length?values.filter(x=>x>=winX).length/values.length:null,avgPeakX:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,medianPeakX:median(values),sampleSufficient:values.length>=minSamples})).filter(row=>row.sampleSufficient).sort((a,b)=>(b.avgPeakX??-1)-(a.avgPeakX??-1));
  }
  memoToken(key,inputs,build) {
    this.tokenDtoCache??=new Map();
    const previous=this.tokenDtoCache.get(key);
    if(previous&&inputs.length===previous.inputs.length&&inputs.every((value,index)=>Object.is(value,previous.inputs[index])))return previous.token;
    const started=performance.now(),token=build();
    this.tokenDtoCache.set(key,{inputs,token});
    this.repo.recordPerformance?.('token_dto_rebuild',performance.now()-started,1);
    return token;
  }
  tokens() {
    const muted=new Set(this.repo.setting('monitorMutes',[]));
    const excluded=new Set(this.repo.setting('statsExclusions',[]));
    const telegramChannels=new Map((this.repo.setting('monitor',{wechat:[],telegram:[]}).telegram||[]).filter(g=>g.kind==='channel').map(g=>['tg:'+g.peerId,g.title||g.peerId]));
    const settingsKey=JSON.stringify([...telegramChannels]);
    if(this.mentionsRevision!==this.repo.mentionsRevision||this.mentionsSettings!==settingsKey||Date.now()-(this.mentionsCachedAt??0)>=60000){
      this.mentionsRevision=this.repo.mentionsRevision;this.mentionsSettings=settingsKey;
      this.mentionsCachedAt=Date.now();
      const mentions=this.repo.all('SELECT chain,address,source,sender,at,channel,message FROM mentions WHERE active=1 AND bot=0 AND EXISTS(SELECT 1 FROM tokens t WHERE t.chain=mentions.chain AND t.address=mentions.address AND t.last_call>=?) ORDER BY at,source,channel,message',now()-RECENT_WINDOW_SEC);
      const byToken=new Map();for(const m of mentions){const key=m.chain+':'+m.address;if(!byToken.has(key))byToken.set(key,[]);const channelTitle=m.source==='telegram'?telegramChannels.get(m.channel)||null:null;const {message,...mention}=m;byToken.get(key).push({...mention,traceId:JSON.stringify([m.source,m.channel,message]),ts:m.at,group:m.channel,isChannelCall:!!channelTitle,channelTitle});}
      for(const [key,calls] of byToken){
        const old=this.mentionsByToken?.get(key);
        if(old&&old.length===calls.length&&calls.every((call,index)=>Object.keys(call).every(field=>call[field]===old[index][field])))byToken.set(key,old);
      }
      this.mentionsByToken=byToken;
    }
    const byToken=this.mentionsByToken,empty=this.emptyMentions??=[];
    // Live monitoring must not wait for the deferred all-history statistics projection.
    const verifiedTokens=this.repo.view({since:now()-RECENT_WINDOW_SEC,reuse:true}).filter(r=>!muted.has(r.chain+':'+r.address)).map(baseRow=>{
      const key=baseRow.chain+':'+baseRow.address,e=this.market?.liveQuote?.(baseRow.chain,baseRow.address);
      const live=e&&e.version===baseRow.version&&['dex','ave'].includes(e.provider)&&e.quote?e:null;
      const receivedAt=live?.receivedAt??baseRow.receivedAt;
      return this.memoToken(key,[true,baseRow,live?.quote,live?.high,live?.provider,live?.receivedAt,byToken.get(key),excluded.has(key),!!receivedAt&&now()-receivedAt<30],()=>{
      const r=this.withLive(baseRow);
      const key=r.chain+':'+r.address,b=r.priceBaseline??r.baseline,q=r.quote;
      const source=q?.provider??q?.mcSource??q?.source;
      const firstCallBase=b&&Number(b.at)<=r.at?b:null;
      const paired=r.pricePeak?.provider===source&&r.pricePeak?.baselinePrice>0&&Number(r.pricePeak.baselineAt)<=r.at?{price:r.pricePeak.baselinePrice,provider:source,approximate:r.pricePeak.approximate}:null;
      const changeBase=firstCallBase?.provider===source&&firstCallBase?.price>0?firstCallBase:paired??firstCallBase;
      const priceRatio=changeBase?.price>0&&q?.price>0?q.price/changeBase.price:null;
      const change=priceRatio!==null?(priceRatio-1)*100:firstCallBase&&q&&compatible(firstCallBase,q)?(q.mc/firstCallBase.mc-1)*100:null;
      // Overlay reference only: cross-provider price comparisons never enter stored peak statistics.
      const changeApprox=!!changeBase?.approximate||(priceRatio!==null&&changeBase?.provider!==source);
      let calls=byToken.get(key)??empty;if(calls[0])calls=[{...calls[0],time:r.at,mc:b?.mc,price:b?.price,approx:!!b?.approximate,mcSource:b?.provider,priceSource:b?.provider,quoteAt:b?.at,mcPrecision:b?.precision},...calls.slice(1)];
      return {key,verified:true,pending:false,address:r.address,chain:r.chain,chainHint:r.chain,logoLookup:r.logoLookup??{},market:{...q,symbol:r.symbol,name:r.name,logo:r.logo,chain:r.chain,receivedAt:r.receivedAt},mentions:calls,firstSeen:r.lastCall,change,currentMultiple:change==null?null:1+change/100,changePendingReason:change!=null?null:b&&Number(b.at)>r.at?'首喊早于首笔可用行情，开盘参考价不能作为首喊基准':!changeBase?'尚未取得有效首喊价格基准':'当前报价暂缺，等待行情恢复',changeApprox,changeBasis:priceRatio!==null?"price":"market-cap",changeBasePrice:changeBase?.price??null,changeBaseSource:changeBase?.provider??null,confirmedPeakX:this.multiple(r),peakSortX:this.multiple(r),referencePeakX:r.referenceMultiple,liveHighMc:r.liveHigh?.mc??null,liveHighX:r.observedPeak?.multiple??(b&&r.liveHigh&&compatible(b,r.liveHigh)?r.liveHigh.mc/b.mc:null),statsExcluded:excluded.has(key),live:!!r.receivedAt&&now()-r.receivedAt<30,trend:change==null?0:Math.sign(change),kol:new Set(calls.map(m=>m.sender)).size,spark:[],monitorMuted:muted.has(key)};
      });
    });
    const pendingRows=this.repo.all(
      `SELECT c.chain,c.address,t.last_call,t.metadata FROM claims c JOIN tokens t USING(chain,address)
       WHERE c.active=1 AND t.blocked=0 AND t.verified=0 AND t.last_call>=?
         AND COALESCE(json_extract(t.metadata,'$.manualDisposition'),'')<>'wallet'
         AND COALESCE(json_extract(t.metadata,'$.autoDisposition'),'') NOT IN ('wallet','unlisted')
       ORDER BY t.last_call DESC,c.address`,
      now()-RECENT_WINDOW_SEC,
    );
    const pendingTokens=pendingRows.filter(r=>!muted.has(r.chain+':'+r.address)).map(r=>{
      const key=r.chain+':'+r.address,calls=byToken.get(key)??empty;
      return this.memoToken(key,[false,r.metadata,r.last_call,calls,excluded.has(key)],()=>{
      let metadata={};try{metadata=JSON.parse(r.metadata||'{}')}catch{}
      const symbol=metadata.symbol||null,name=metadata.name||null,logo=metadata.logo||null;
      return {key,address:r.address,chain:r.chain,chainHint:r.chain,verified:false,pending:true,symbol,name,logo,logoLookup:metadata.logoLookup||{},market:{chain:r.chain,symbol,name,logo},mentions:calls,firstSeen:r.last_call,change:null,currentMultiple:null,changeApprox:false,confirmedPeakX:null,peakSortX:null,statsExcluded:excluded.has(key),live:false,trend:0,kol:new Set(calls.map(m=>m.sender)).size,spark:[],monitorMuted:false};
      });
    });
    const tokens=[...verifiedTokens,...pendingTokens],keys=new Set(tokens.map(t=>t.key));
    for(const key of this.tokenDtoCache?.keys()??[])if(!keys.has(key))this.tokenDtoCache.delete(key);
    return tokens;
  }
  taskHealth(){
    const ts=now(),h=this.repo.setting('workerHealth',{});
    // Future history jobs are the twelve-hour quiet-window boundary, not a retry queue.
    const jobs=this.repo.all("SELECT CASE WHEN state='QUEUED' AND due>? AND json_extract(payload,'$.refresh')=1 THEN 'SCHEDULED' WHEN state='QUEUED' AND due>? AND lane='capture' AND json_extract(payload,'$.stage')='history' AND json_extract(payload,'$.manualBatchId') IS NULL THEN 'WAITING_QUIET' WHEN state='QUEUED' AND due>? AND json_extract(payload,'$.manualBatchId') IS NULL THEN 'SCHEDULED' ELSE state END state,COUNT(*) n FROM jobs WHERE lane='capture' AND state IN('QUEUED','BACKOFF','RUNNING','FAILED','PARKED') GROUP BY 1",ts,ts,ts);
    const counts=Object.fromEntries(jobs.map(j=>[j.state,j.n])),pending=(counts.QUEUED||0)+(counts.BACKOFF||0)+(counts.RUNNING||0);
    const retry=this.repo.get("SELECT due,last_error FROM jobs WHERE lane='capture' AND state='BACKOFF' ORDER BY due LIMIT 1");
    // A finished or unrelated query must not keep the whole app marked unhealthy.
    const retryError=String(retry?.last_error||'');
    const rate=/429|限流|rate.?limit|FLOOD_WAIT/i.test(retryError);
    const timeout=/超时|timeout|timed out/i.test(retryError);
    const age=Math.max(0,ts-(h.lastFinishedAt||h.startedAt||ts));
    const completed10m=h.completed10m??null,failed10m=h.failed10m??null,uptime=Math.max(0,ts-(h.startedAt||ts));
    let state='idle',label='采集任务空闲',reason='';
    if(pending){if(h.heartbeatAt&&ts-h.heartbeatAt>15){state='stalled';label='后台调度无响应';reason='任务心跳超过15秒未更新，请导出日志';}
      else if(rate){state='rate-limited';label='平台限流，等待继续';reason=retryError;}
      else if(/会话|登录|session/i.test(retryError)){state='waiting-session';label='等待AVE网页会话恢复';reason=retryError;}
      else if(timeout){state='timeout';label='部分查询超时，等待重试';reason=retryError;}
      else if(age>=90){state='stalled';label='长时间无进展';reason=`已${age}秒没有任务结束，超时任务会结束并保留已有数据`;}
      else if(completed10m===0&&uptime>=600){state='stalled';label='最近10分钟无进展';reason=`最近10分钟完成 0 个任务、失败 ${failed10m??0} 次，请导出日志`;}
      else if(counts.RUNNING){state='running';label='正在查询或补查行情';}
      else if(counts.BACKOFF&&!counts.QUEUED){state='retrying';label='有查询异常等待处理';}
      else{state='queued';label='新喊单等待处理';}}
    else if(counts.WAITING_QUIET){state='waiting-quiet';label='等待历史增量补查';reason=`${counts.WAITING_QUIET} 项到时自动补查，已有行情继续刷新`;}
    else if(counts.SCHEDULED){state='scheduled';label='等待下一次增量补查';reason='按批次查询新增行情，已有高点保留';}
    else if(failed10m>0){state='partial';label='本轮查询结束，部分未取得';reason='已保留取得的数据，未取得项目可查看原因';}
    const result={state,label,reason,pending,running:counts.RUNNING||0,queued:counts.QUEUED||0,backoff:counts.BACKOFF||0,failed:counts.FAILED||0,parked:counts.PARKED||0,scheduled:counts.SCHEDULED||0,waitingQuiet:counts.WAITING_QUIET||0,completed10m,failed10m,lastFinishedAt:h.lastFinishedAt||null,heartbeatAt:h.heartbeatAt||null,waitSeconds:retry?.due?Math.max(0,retry.due-ts):0};
    if(state!==this.lastHealthState){this.lastHealthState=state;this.repo.diagnostic('task_health',null,JSON.stringify(result));}
    return result;
  }
  deliveryTrace(rawAddress, group) {
    const raw = String(rawAddress ?? '').trim();
    const evm = /^0x[a-f0-9]{40}$/i.test(raw);
    if (!evm && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) {
      throw Error('请输入完整 CA');
    }
    const address = evm ? raw.toLowerCase() : raw;
    const settings = this.repo.setting('monitor', { wechat: [], telegram: [] });
    const watched = new Set([...settings.wechat, ...settings.telegram.map(chat => 'tg:' + chat.peerId)]);
    const messages = this.repo.all(`
      SELECT DISTINCT m.source, m.channel, m.message, m.active, m.payload
      FROM mentions a JOIN messages m USING(source, channel, message)
      WHERE a.address=? AND (?='' OR m.channel=?)
      ORDER BY m.revision DESC LIMIT 30`, address, group, group);
    const entries = messages.map(message => {
      const payload = JSON.parse(message.payload);
      const stream = JSON.stringify([message.source, message.channel, message.message]);
      const prefix = JSON.stringify([stream, address]).slice(0, -1) + ',';
      const receipt = this.repo.get(
        'SELECT max(at) AS at FROM delivery_receipts WHERE id>=? AND id<?',
        prefix, prefix.slice(0, -1) + '-',
      );
      const pending = this.repo.get(
        'SELECT attempts FROM delivery_outbox WHERE id>=? AND id<? LIMIT 1',
        prefix, prefix.slice(0, -1) + '-',
      );
      const status = receipt?.at ? 'sent'
        : pending ? (pending.attempts ? 'retrying' : 'queued')
        : !message.active || !(payload.addresses ?? payload.addrs ?? []).includes(address) ? 'inactive'
        : payload.backfill ? 'backfilled'
        : 'no_receipt';
      return { source: message.source, at: payload.at ?? payload.time, status, sentAt: receipt?.at ?? null };
    });
    return { entries, groupWatched: group ? watched.has(group) : null };
  }

  async handle(req,url,body) {
    if(url.pathname==='/api/overlay/logo-failed'&&req.method==='POST')return this.market.reportLogoFailure(body.chain,body.address,body.logo);
    if(url.pathname==='/api/market-data/repair'&&req.method==='GET')return this.repairSnapshot();
    if(url.pathname==='/api/market-data/repair'&&req.method==='POST'){
      if(body.mode!==undefined&&!['missing','full'].includes(body.mode))throw Error('只支持手动查询缺失的喊后高点；不会重查已完成数据');
      if(Object.keys(body).some(key=>key!=='mode'))throw Error('批量补查仅支持缺失项，不接受地址筛选或全量重查');
      const result=this.startManualRepairBatch();
      return body.mode==='full'?{...result,mode:'missing',message:`全量重查已关闭，本次仅处理缺失项。${result.message}`} : result;
    }
    if(url.pathname==='/api/market-data/repair/stop'&&req.method==='POST')return this.stopManualRepairBatch();
    if(url.pathname==='/api/market-data/audit'&&req.method==='GET'){
      const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||100)),offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
      return this.auditSnapshot(limit,offset);
    }
    if(url.pathname==='/api/market-data/audit/export'&&req.method==='GET'){
      const snapshot=this.auditSnapshot(5000,0);
      const diagnostics=this.repo.all("SELECT at,category,token,detail FROM diagnostics WHERE category IN('manual_repair','job_failure','baseline','history','chain_unresolved') ORDER BY id DESC LIMIT 500");
      return {...snapshot,diagnostics,exportedAt:now()};
    }
    if(url.pathname==='/api/task-health')return this.taskHealth();
    if(url.pathname==='/api/acquisition-summary'){
      // Use the persisted inventory as the sole denominator: one active,
      // verified, unblocked token with a stored token row. Unconfirmed address
      // candidates and mentions that have not entered the inventory are out.
      const rows=this.repo.view();
      const counts={archived:0,chain:0,timeout:0,interrupted:0,noData:0,querying:0,waitingQuiet:0,scheduledRefresh:0,retrying:0,failed:0,stopped:0,other:0};
      let ready=0,noBase=0,noPeak=0,observed=0;
      for(const token of rows){if(token.priceMultiple!=null){ready++;continue;}
        const baseline=token.priceBaseline??token.baseline;
        if(token.observedPeak?.multiple>0)observed++;
        if(!baseline)noBase++;else if(!(token.pricePeak??token.formalPeak))noPeak++;
        const job=this.repo.get("SELECT state,wait,last_error,payload,due FROM jobs WHERE lane='capture' AND chain=? AND address=? AND claim_version=?",token.chain,token.address,token.version)||{};
        const status=acquisitionStatus(job);
        if(status.key!=='other'&&status.key!=='complete'){counts[status.key]=(counts[status.key]||0)+1;continue;}
        const text=String(job.last_error||'');
        const key=token.chain==='?'||job.wait==='chain'||/所属链/.test(text)?'chain':
          /超时|timeout/i.test(text)?'timeout':/重启|中断/.test(text)?'interrupted':
          /暂无|未取得|尚无|无有效|未返回|不是代币|未确认/.test(text)||job.state==='PARKED'?'noData':'other';
        counts[key]++;}
      return {...counts,total:rows.length,ready,missing:rows.length-ready,noBase,noPeak,observed};
    }
    const p=url.pathname,method=req.method, rows=()=>this.rows(url),include=url.searchParams.get('includeApprox')==='true',winX=Math.max(1,Number(url.searchParams.get('winX'))||2);
    if(p==='/api/address-candidates'&&method==='POST'){
      if(body.confirmWallet!==true)throw Error('请先确认该地址是普通钱包地址');
      return this.market.ingestion.markUnknownWallet(String(body.address||''));
    }
    if(p==='/api/address-candidates/restore-wallet'&&method==='POST')
      return this.market.ingestion.restoreUnknownWallet(String(body.address||''));
    if(p==='/api/address-candidates/ignored')return this.repo.all(`
      SELECT t.address,t.metadata,c.at,m.sender,m.source,m.channel
      FROM tokens t JOIN claims c ON c.chain=t.chain AND c.address=t.address
      JOIN mentions m ON m.id=c.owner
      WHERE t.verified=0 AND t.blocked=0 AND c.active=1
        AND (json_extract(t.metadata,'$.manualDisposition')='wallet' OR json_extract(t.metadata,'$.autoDisposition') IN ('wallet','unlisted'))
      ORDER BY c.at DESC,t.address`).map(r=>{const metadata=JSON.parse(r.metadata||'{}');return {address:r.address,markedAt:metadata.autoDispositionAt||metadata.manualDispositionAt,disposition:metadata.autoDisposition==='unlisted'?'unlisted':metadata.autoDisposition==='wallet'?'automatic':'manual',reason:metadata.autoDispositionReason||null,audit:metadata.autoWalletAudit||null,at:r.at,sender:r.sender,source:r.source,channel:r.channel};});
    if(p==='/api/address-candidates')return this.repo.all(`
      SELECT c.chain,c.address,c.at,m.sender,m.source,m.channel,t.metadata,
        (SELECT count(*) FROM mentions x WHERE x.chain=c.chain AND x.address=c.address AND x.active=1 AND x.bot=0) mentionCount,
        (SELECT j.state FROM jobs j WHERE j.chain=c.chain AND j.address=c.address AND j.claim_version=c.version AND j.lane='capture' ORDER BY j.updated_at DESC,j.id DESC LIMIT 1) jobState,
        (SELECT j.wait FROM jobs j WHERE j.chain=c.chain AND j.address=c.address AND j.claim_version=c.version AND j.lane='capture' ORDER BY j.updated_at DESC,j.id DESC LIMIT 1) wait,
        (SELECT j.last_error FROM jobs j WHERE j.chain=c.chain AND j.address=c.address AND j.claim_version=c.version AND j.lane='capture' ORDER BY j.updated_at DESC,j.id DESC LIMIT 1) lastError,
        (SELECT j.updated_at FROM jobs j WHERE j.chain=c.chain AND j.address=c.address AND j.claim_version=c.version AND j.lane='capture' ORDER BY j.updated_at DESC,j.id DESC LIMIT 1) checkedAt
      FROM claims c JOIN tokens t USING(chain,address) JOIN mentions m ON m.id=c.owner
      WHERE c.active=1 AND c.chain='?' AND t.blocked=0 AND t.verified=0
        AND COALESCE(json_extract(t.metadata,'$.manualDisposition'),'')<>'wallet'
        AND COALESCE(json_extract(t.metadata,'$.autoDisposition'),'') NOT IN ('wallet','unlisted')
      ORDER BY c.at DESC,c.address` ).map(r=>{
        const metadata=JSON.parse(r.metadata||'{}'),audit=metadata.autoWalletAudit;
        const fallback=metadata.chainResolutionFallback||{};
        const fallbackErrors=[fallback.avePage?.error,fallback.dex?.error].filter(Boolean);
        const auditTransient=audit?.status==='unknown'&&/(?:RPC|timeout|超时|temporarily unavailable|429|限流|网络异常|fetch failed)/i.test(String(audit.reason||''));
        const transientRetry=(fallback.complete===false&&fallbackErrors.length>0)||auditTransient;
        const retryAt=Number(fallback.retryAt||audit?.retryAt||0);
        const {metadata:_metadata,...candidate}=r;
        const walletAuditEligible=['?','sol','eth','bsc','base','monad','robinhood','arc'].includes(r.chain)&&!audit;
        const status=transientRetry?'临时故障，自动重试中':audit?.status==='checking'?'正在自动复核':audit?.status==='contract'?'自动复核发现合约，保留核对':audit?.status==='unknown'?'自动复核未确认，稍后重试':walletAuditEligible?'自动钱包复核排队中':r.wait==='manual_review'?'待人工核对':['QUEUED','BACKOFF','RUNNING'].includes(r.jobState)?'正在查询喊单行情':r.jobState==='FAILED'?'查询失败':r.jobState==='PARKED'?'等待后续核对':'待处理';
        const reason=transientRetry?fallbackErrors.join('；')||audit?.reason||r.lastError||'临时查询失败，等待自动重试':audit?.status==='checking'?'正在查询链上账户和签名记录':audit?.reason||r.lastError||(r.chain==='?'?'尚未确认所属链':'尚未取得喊单前价格基准');
        return {...candidate,walletAudit:audit||null,queue:transientRetry?'retry':'review',retryAt:transientRetry?retryAt:null,status,reason};
      });
    if(p==='/api/settings'&&method==='GET')return this.settings();
    if(p==='/api/settings'&&method==='PUT'){
      const s={...this.settings(),...body};
      if(body.senderFilters)this.repo.set('senderFilters',body.senderFilters);
      if(body.panel)this.repo.set('panel',body.panel);
      this.collectors.update({wechat:s.groups,telegram:s.telegramGroups});this.broadcast();return this.settings();
    }
    if(p==='/api/overview'){
      const list=rows(),countable=list.filter(r=>!r.excluded&&this.multiple(r,include)!=null),values=countable.map(r=>this.multiple(r,include));
      const eligible=countable.length, calls=this.stats(list,include,winX,1),groups=[...new Set(this.repo.projection('rows',[]).map(r=>r.channel))].map(id=>({id,name:this.groupNames.get(id)??id}));
      return {now:now(),firstTs:list.length?Math.min(...list.map(r=>r.at)):null,totalTokens:list.length,totalCalls:list.length,quality:{mature:list.length,eligible,missing:list.filter(r=>!(r.priceBaseline??r.baseline)||!r.pricePeak&&!r.formalPeak&&!r.referencePeak).length,excludedApprox:list.filter(r=>!r.excluded&&this.isApproximateBaseline(r)&&!include).length,excluded:list.filter(r=>r.excluded).length,rejected:0,winRate:eligible?values.filter(x=>x>=winX).length/eligible:0},groups,callers:calls,callerRanking:{minSamples:1,minSamplesPerOutcome:1},top:[],recent:[]};
    }
    if(p==='/api/stats')return this.stats(rows(),include,winX);
    if(p==='/api/sender')return rows().filter(r=>r.senderKey===(url.searchParams.get('key')??url.searchParams.get('sender'))||r.sender===url.searchParams.get('sender')).map(r=>this.call(r,include));
    if(p==='/api/report'){
      const list=rows(),calls=list.map(r=>this.call(r,include)),eligible=calls.filter(c=>c.performanceEligible),values=eligible.map(c=>c.peakX),hit=values.filter(x=>x>=winX).length;
      return {now:now(),hours:Number(url.searchParams.get('hours'))||24,calls,matureCalls:calls,groups:Object.fromEntries(this.groupNames),matureSummary:{total:list.length,eligible:eligible.length,included:eligible.length,incomplete:list.length-eligible.length,inProgress:0,winX,hitThreshold:hit,hitThresholdRate:values.length?hit/values.length:null,medianPeakX24:median(values),excludedApprox:list.filter(r=>this.isApproximateBaseline(r)&&!include).length}};
    }
    if(p==='/api/groups'&&method==='GET')return this.groups(url.searchParams.get('source')??'wechat');
    if(p==='/api/telegram/status')return this.collectors.telegram.status();
    const tg={'/api/telegram/credentials':'configure','/api/telegram/login/send-code':'code','/api/telegram/login/code':'verify','/api/telegram/login/password':'password'};
    if(tg[p]){if(tg[p]==='configure'&&!body.apiHash&&this.collectors.telegram.status().configured)return this.collectors.telegram.status();return this.collectors.action(tg[p],body);}
    if(p==='/api/sources'||p==='/api/sources/diagnostics'){
      let ready=false,error=null;try{this.collectors.wechat.reader.listGroups(1);ready=true;}catch(e){error=e.message;}
      return {configured:ready,wechat:{ready,installed:!!autoDetectDbDir(),keys:fs.existsSync(KEYS_FILE),dbDir:autoDetectDbDir(),error}};
    }
    if(p==='/api/sources/wechat/setup'){await this.bridge.rpc('desktop.action',{action:'keys'});return this.handle({...req,method:'GET'},new URL('/api/sources',url),{});}
    const senders=p.match(/^\/api\/(wechat\/groups|telegram\/chats)\/([^/]+)\/senders$/);
    if(senders){const id=decodeURIComponent(senders[2]);if(senders[1].startsWith('telegram'))return this.collectors.telegram.senders(id);
      const map=new Map();for(const m of this.collectors.wechat.reader.readRange(id,now()-7*86400,now(),600)){const key=m.senderId??m.sender;if(!map.has(key))map.set(key,{id:key,name:m.sender,messages:0});map.get(key).messages++;}return [...map.values()];}
    if(p==='/api/tokens')return this.tokens();
    if(p==='/api/market-data/source'){if(method==='POST')throw Error('单币行情源切换已移除');return {choices:{}};}
    if(p==='/api/market-data/live-status')return {choices:{},primaryPending:[...this.market.active.keys()],providers:{},failures:{},events:this.tokens().filter(t=>t.market?.receivedAt).map(t=>({chain:t.chain,address:t.address,role:'primary',status:'applied',receivedAt:t.market.receivedAt}))};
    if(p==='/api/stats/exclusions'){
      let items=this.repo.setting('statsExclusions',[]);if(method==='POST'){const key=body.chain+':'+body.address;items=items.filter(k=>k!==key);if(body.excluded)items.push(key);this.repo.set('statsExclusions',items);this.broadcast();}
      return this.repo.projection('rows',[]).filter(r=>items.includes(r.chain+':'+r.address)).map(r=>({chain:r.chain,address:r.address,symbol:r.symbol,logo:r.logo}));
    }
    if(p==='/api/caller-labels'){let labels=this.repo.setting('callerLabels',{});if(method==='POST'){const raw=String(body.raw??'').slice(0,256),label=String(body.label??'').trim().slice(0,64);if(!raw)throw Error('喊单人不能为空');if(label)labels[raw]=label;else delete labels[raw];this.repo.set('callerLabels',labels);this.broadcast();}return labels;}
    if(p==='/api/monitor-mutes'){let items=this.repo.setting('monitorMutes',[]);if(method==='POST'){const key=body.chain+':'+body.address;items=items.filter(k=>k!==key);if(body.muted)items.push(key);this.repo.set('monitorMutes',items);this.broadcast();}return [...new Set(items)].filter(key=>typeof key==='string'&&key.indexOf(':')>0).map(key=>{
      const i=key.indexOf(':'),chain=key.slice(0,i),address=key.slice(i+1);
      const row=this.repo.get('SELECT metadata FROM tokens WHERE chain=? AND address=?',chain,address);
      let metadata={};try{metadata=JSON.parse(row?.metadata||'{}');}catch{}
      return {key,chain,address,symbol:metadata.symbol||null,logo:metadata.logo||null};
    });}
    if(p==='/api/chain-probe-batch'&&method==='POST'){
      const chain=canonicalChain(body.chain);
      if(!isAveChainSlug(chain)||!Array.isArray(body.addresses)||!body.addresses.length||body.addresses.length>40||body.addresses.some(a=>!(chain==='sol'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a):/^0x[\da-f]{40}$/i.test(a))))throw Error('探测参数无效');
      const results=[];
      for(const address of body.addresses){try{const market=await this.market.quote('ave',chain,address,'background');const matched=!!(market&&(market.symbol||market.name||Number(market.price)>0||Number(market.mc)>0));results.push({address,matched,market,reason:matched?undefined:'AVE 未返回可确认的代币资料'});}catch(error){results.push({address,matched:false,error:error.message});}}
      return {provider:'ave',chain,results};
    }
    if(p==='/api/quote-details'){const provider=body.provider??'ave';if(provider!=='ave')throw Error('单币资料查询仅支持 AVE');const m=await this.market.quote(provider,body.chain,body.address,'interactive');if(!m||!(m.symbol||m.name||Number(m.price)>0||Number(m.mc)>0))return {ok:true,provider,found:false};return {ok:true,provider,found:true,...m,priceUsd:m.price,marketCapUsd:m.mc,liquidityUsd:m.liq,quoteAt:m.quoteAt?m.quoteAt*1000:null,receivedAt:Date.now()};}
    if(p==='/api/provider-inspection'&&method==='POST'){
      const chain=String(body.chain),address=String(body.address),provider='ave',kline=body.mode==='kline';
      const routeChain=canonicalChain(chain);
      if((body.provider!=null&&body.provider!=='ave')||!isAveChainSlug(routeChain)||!(routeChain==='sol'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address):/^0x[\da-f]{40}$/i.test(address)))throw Error('查询参数无效');
      const to=now(),from=to-3600;
      const response=await this.bridge.aveQuery({chain:routeChain,address,mode:kline?'kline':'detail',...(kline?{interval:60,from,to}:{})});
      let json;try{json=JSON.parse(response.body);}catch{return {provider,http:response.status,error:'返回非JSON内容',detail:response.error};}
      return {provider,http:response.status,routeChain,mode:kline?'kline':'token',payload:json};
    }
    if(p==='/api/delivery-trace' && method==='GET') return this.deliveryTrace(url.searchParams.get('address'), url.searchParams.get('group') ?? '');
    if(p==='/api/telegram-bot/status')return this.collectors.publisher.status();
    if(p==='/api/telegram-bot/config'&&method==='POST')return this.collectors.publisher.configure(body);
    if(p==='/api/telegram-bot/check'&&method==='POST')return this.collectors.publisher.checkConnection();
    if(p==='/api/telegram-bot/test'&&method==='POST')return this.collectors.publisher.sendTest();
    return undefined;
  }
}
