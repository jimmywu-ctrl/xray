import test from 'node:test';
import assert from 'node:assert/strict';
import {Repository} from '../src/infra/database.mjs';
import {MarketService} from '../src/services/market.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {Worker} from '../src/infra/worker.mjs';
import {DashboardContract} from '../src/services/dashboard-contract.mjs';
import {acquisitionStatus} from '../src/services/acquisition-status.mjs';
import {Dex} from '../src/adapters/core/dex.ts';
import {now} from '../src/domain/rules.mjs';

const address='0x'+'7'.repeat(40);
function fixture(days=3){
  const repo=new Repository(':memory:'), ingestion=new IngestionService(repo);
  const at=Math.floor((now()-days*86400)/300)*300;
  ingestion.ingest({source:'telegram',channel:'tg:completion',message:'seed',at,chain:'bsc',addresses:[address],sender:'A',senderId:'a'});
  repo.run('UPDATE tokens SET verified=1 WHERE address=?',address);
  const token=repo.claim('bsc',address),base={provider:'ave',unit:'price',value:1,price:1,at:at-1};
  repo.run('INSERT INTO price_results(chain,address,claim_version,baseline,updated_at) VALUES(?,?,?,?,?)','bsc',address,token.version,JSON.stringify(base),at);
  const market=new MarketService(repo,{}, {recompute(){},publish(){repo.project();}},ingestion);
  return {repo,market,token,at};
}

test('quiet, daily refresh, no K line and failed network are distinct states',()=>{
  const job={state:'QUEUED',due:now()+3600,payload:JSON.stringify({stage:'history'})};
  assert.equal(acquisitionStatus(job).key,'waitingQuiet');
  assert.equal(acquisitionStatus({...job,payload:{stage:'history',refresh:true}}).key,'scheduledRefresh');
  assert.equal(acquisitionStatus({state:'PARKED',wait:'nodata'}).key,'noData');
  assert.equal(acquisitionStatus({state:'PARKED',wait:'limit'}).key,'failed');
  assert.equal(acquisitionStatus({state:'BACKOFF',last_error:'network timeout'}).key,'retrying');
});

test('daily work queries only new candles and cannot lower or erase a confirmed high',async()=>{
  const {repo,market,token,at}=fixture(4);
  try{
    const cursor=at+86417,old={provider:'ave',unit:'price',price:5,multiple:5,baselinePrice:1,baselineAt:at-1,at:at+600,coverage:{from:at+1,to:cursor}};
    repo.run('UPDATE price_results SET peak=? WHERE address=?',JSON.stringify(old),address);
    const requests=[];
    market.priceBars=async(_p,_t,from,to)=>{requests.push({from,to});return [{time:Math.ceil(from/300)*300,high:2,close:1.5}];};
    const ctx={job:{chain:'bsc',address,payload:{stage:'history',refresh:true}},guard:()=>true};
    await market.priceAcquisition.history(ctx);
    let peak=JSON.parse(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak);
    assert.equal(peak.multiple,5);
    assert.equal(peak.at,old.at);
    assert.equal(peak.coverage.to,Math.floor(cursor/300)*300+86400);
    assert.ok(requests.every(r=>r.from>=Math.floor(cursor/300)*300));
    market.priceBars=async()=>[];
    await market.priceAcquisition.history(ctx);
    const empty=JSON.parse(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak);
    assert.equal(empty.multiple,peak.multiple);assert.equal(empty.at,peak.at);
    assert.ok(empty.coverage.to>peak.coverage.to);assert.equal(empty.coverage.emptyRanges.length,1);
    market.priceBars=async(_p,_t,from)=>[{time:Math.ceil(from/300)*300,high:8,close:7}];
    await market.priceAcquisition.history(ctx);
    assert.equal(JSON.parse(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak).multiple,8);
  }finally{repo.close();}
});

test('daily scheduler reuses one job and preserves completed manual report after restart',()=>{
  const {repo,market,token,at}=fixture();
  try{
    repo.run('UPDATE price_results SET peak=? WHERE address=?',JSON.stringify({multiple:3,provider:'ave'}),address);
    repo.run("UPDATE jobs SET state='DONE',payload=? WHERE address=?",JSON.stringify({stage:'history',manual:true,manualBatchId:'completed'}),address);
    repo.set('manualRepairBatchV1',{id:'completed',status:'complete',total:1});
    market.schedulePeakRefreshes();
    let job=repo.get('SELECT * FROM jobs WHERE address=?',address);
    assert.equal(job.state,'QUEUED');assert.equal(JSON.parse(job.payload).refresh,true);
    assert.equal(JSON.parse(job.payload).manualBatchId,undefined);
    market.lastPeakRefreshScan=0;market.schedulePeakRefreshes();
    assert.equal(repo.get('SELECT COUNT(*) n FROM jobs WHERE address=?',address).n,1);
    const contract=new DashboardContract(repo,{},market,{},()=>{});
    assert.equal(contract.manualRepairRows('completed').length,1);
    assert.equal(contract.manualRepairRows('completed')[0].state,'DONE');
    assert.equal(repo.get('SELECT COUNT(*) n FROM price_results WHERE address=?',address).n,1);
  }finally{repo.close();}
});

test('observed high is durable and source-matched, separate from confirmed statistics',()=>{
  const {repo,market,token,at}=fixture();
  try{
    market.recordObservedPeak(token,{price:4,quoteAt:at+100},'dex');
    assert.equal(repo.get('SELECT observed_peak FROM price_results WHERE address=?',address).observed_peak,null);
    market.recordObservedPeak(token,{price:3,quoteAt:at+100},'ave');
    market.recordObservedPeak(token,{price:2,quoteAt:at+200},'ave');
    market.recordObservedPeak(token,{price:99,quoteAt:at},'ave');
    market.live.clear();market.liveHighs.clear();
    const row=repo.tokenByAddress(address,'bsc');
    assert.equal(row.observedPeak.multiple,3);assert.equal(row.priceMultiple,null);assert.equal(row.pricePeak,null);
    const contract=new DashboardContract(repo,{},market,{},()=>{});
    assert.equal(contract.call(row,true).performanceEligible,false);
    assert.equal(contract.call(row,true).observedPeakX,3);
  }finally{repo.close();}
});

test('simultaneous metadata consumers share one provider request and brief cache',async()=>{
  const {repo,market}=fixture(),original=Dex.lookup;
  try{
    let calls=0,release;const gate=new Promise(r=>release=r);
    Dex.lookup=async()=>{calls++;await gate;return {chain:'bsc',symbol:'T',price:1};};
    const a=market.quote('dex','bsc',address,'background'),b=market.quote('dex','bsc',address,'live');
    release();assert.deepEqual(await a,await b);assert.equal(calls,1);
    await market.quote('dex','bsc',address,'background');assert.equal(calls,1);
    await market.quote('dex','bsc',address,'live');assert.equal(calls,2,'live refresh bypasses background cache');
  }finally{Dex.lookup=original;repo.close();}
});

test('an empty daily refresh waits a full day, while manual stop stays stopped',()=>{
  const {repo,market}=fixture();
  try{
    repo.run('UPDATE price_results SET peak=? WHERE address=?',JSON.stringify({multiple:3,provider:'ave'}),address);
    repo.run("UPDATE jobs SET state='PARKED',wait='nodata',updated_at=? WHERE address=?",now(),address);
    market.schedulePeakRefreshes();assert.equal(repo.get('SELECT state FROM jobs WHERE address=?',address).state,'PARKED');
    repo.run('UPDATE jobs SET updated_at=? WHERE address=?',now()-86401,address);
    market.lastPeakRefreshScan=0;market.schedulePeakRefreshes();
    assert.equal(repo.get('SELECT state FROM jobs WHERE address=?',address).state,'QUEUED');
    repo.run("UPDATE jobs SET state='PARKED',wait='manual_stop',updated_at=? WHERE address=?",now()-86401,address);
    market.lastPeakRefreshScan=0;market.schedulePeakRefreshes();
    assert.equal(repo.get('SELECT state FROM jobs WHERE address=?',address).state,'PARKED');
  }finally{repo.close();}
});

test('repeat shout keeps incremental history scheduled within fifteen minutes',()=>{
  const {repo,market}=fixture();
  try{
    repo.run("UPDATE jobs SET payload=?,state='DONE' WHERE address=?",JSON.stringify({stage:'history',refresh:true}),address);
    market.ingestion.ingest({source:'telegram',channel:'tg:completion',message:'repeat',at:now(),chain:'bsc',addresses:[address],sender:'A',senderId:'a'});
    const job=repo.get('SELECT * FROM jobs WHERE address=?',address);
    assert.equal(acquisitionStatus(job).key,'scheduledRefresh');
    assert.ok(job.due<=now()+900);
  }finally{repo.close();}
});

test('finished timeout diagnostics cannot mislabel healthy current work',()=>{
  const {repo,market}=fixture();
  try{
    repo.run("UPDATE jobs SET state='RUNNING' WHERE address=?",address);
    repo.diagnostic('history',address,'provider timeout');
    const contract=new DashboardContract(repo,{},market,{},()=>{});
    assert.equal(contract.taskHealth().state,'running');
    repo.run("UPDATE jobs SET state='BACKOFF',last_error='provider timeout',due=? WHERE address=?",now()+30,address);
    assert.equal(contract.taskHealth().state,'timeout');
    assert.match(contract.taskHealth().label,/等待重试/);
  }finally{repo.close();}
});

test('long manual repair checkpoints each day and continues until the requested time',async()=>{
  const {repo,market,at}=fixture();
  const latestCompletedAt=Math.floor(now()/300)*300;
  const worker=new Worker(repo,market.handlers());
  try{
    repo.run('UPDATE jobs SET payload=? WHERE address=?',JSON.stringify({stage:'history',manual:true,manualBatchId:'paged'}),address);
    market.priceBars=async(_p,_t,from,to)=>[{time:Math.ceil(from/300)*300,high:3,close:2}];
    let pages=0;
    for(;pages<5;pages++){
      repo.run('UPDATE jobs SET due=? WHERE address=?',now()-1,address);
      const claimed=worker.claim('capture');assert.ok(claimed);
      await worker.execute(claimed);
      const row=repo.get('SELECT state,payload FROM jobs WHERE address=?',address);
      assert.equal(JSON.parse(row.payload).manualBatchId,'paged');
      if(row.state==='DONE')break;
      assert.equal(row.state,'QUEUED');
    }
    assert.ok(pages>=2&&pages<5,'all historical pages were processed');
    const peak=JSON.parse(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak);
    assert.ok(peak.coverage.to>=latestCompletedAt);assert.equal(peak.coverage.from,at+1);
  }finally{worker.stop();repo.close();}
});

test('observed high from an earlier owner cannot leak into a new claim baseline',()=>{
  const {repo,market,token}=fixture();
  try{
    market.recordObservedPeak(token,{price:10,quoteAt:now()},'ave');
    assert.ok(repo.get('SELECT observed_peak FROM price_results WHERE address=?',address).observed_peak);
    repo.run('UPDATE claims SET version=version+1 WHERE address=?',address);
    market.priceAcquisition.saveBaseline({...token,version:token.version+1},{provider:'ave',price:2,value:2,at:now()}, {guard:()=>true});
    assert.equal(repo.get('SELECT observed_peak FROM price_results WHERE address=?',address).observed_peak,null);
  }finally{repo.close();}
});

test('empty first day does not hide a later traded day in a manual historical repair',async()=>{
  const {repo,market,at}=fixture(),worker=new Worker(repo,market.handlers());
  try{
    repo.run('UPDATE jobs SET payload=? WHERE address=?',JSON.stringify({stage:'history',manual:true,manualBatchId:'empty-gap'}),address);
    market.priceBars=async(_p,_t,from,to)=>to<=at+86401?[]:[{time:Math.ceil(from/300)*300,high:6,close:4}];
    await worker.execute(worker.claim('capture'));
    let job=repo.get('SELECT * FROM jobs WHERE address=?',address);
    assert.equal(job.state,'QUEUED');assert.ok(JSON.parse(job.payload).historyCursor>at+86400);
    assert.equal(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak,null);
    repo.run('UPDATE jobs SET due=? WHERE address=?',now()-1,address);
    await worker.execute(worker.claim('capture'));
    assert.equal(JSON.parse(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak).multiple,6);
    const peak=JSON.parse(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak);
    assert.equal(peak.coverage.from,at+1);assert.equal(peak.coverage.emptyRanges.length,1);
  }finally{worker.stop();repo.close();}
});

test('manual repair can take over an automatic quiet-window wait immediately',()=>{
  const {repo,market}=fixture();
  try{
    repo.run("UPDATE jobs SET state='QUEUED',payload=?,due=? WHERE address=?",JSON.stringify({stage:'history'}),now()+3600,address);
    const contract=new DashboardContract(repo,{},market,{},()=>{});
    const result=contract.startManualRepairBatch();
    assert.equal(result.total,1);assert.equal(result.skipped,0);
    const job=repo.get('SELECT * FROM jobs WHERE address=?',address);
    assert.ok(job.due<=now());assert.equal(JSON.parse(job.payload).manualBatchId,result.runId);
    assert.equal(acquisitionStatus(job).key,'querying');
  }finally{repo.close();}
});
