import test from 'node:test';
import assert from 'node:assert/strict';
import {Repository} from '../src/infra/database.mjs';
import {Worker} from '../src/infra/worker.mjs';
import {MarketService} from '../src/services/market.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {DashboardContract} from '../src/services/dashboard-contract.mjs';
import {PriceAcquisition} from '../src/services/price-acquisition.mjs';
import {TelegramMonitor} from '../src/adapters/telegram/monitor.ts';
import {WatchManager} from '../src/adapters/core/watchers.ts';
import {usableAvatarUrl} from '../src/services/avatar-policy.mjs';
import {Dex} from '../src/adapters/core/dex.ts';
import {now, CAPTURE_QUIET_WINDOW_SEC} from '../src/domain/rules.mjs';
const a=id=>'0x'+id.toString(16).padStart(40,'0');
const goodLogo='https://www.iconaves.com/token/audit.png';
const oldLogo='https://gmgn.ai/external-res/audit.webp';

test('approximate baseline filter is applied consistently to call details',()=>{
  const contract=Object.create(DashboardContract.prototype);
  contract.repo={get:()=>({n:0})};
  const row={version:1,address:a(1),chain:'bsc',sender:'s',senderKey:'s',at:now(),verified:true,excluded:false,
    priceBaseline:{approximate:true,price:1},pricePeak:{price:3},priceMultiple:3};
  assert.equal(contract.multiple(row,false),null);
  assert.equal(contract.call(row,false).performanceEligible,false);
  assert.match(contract.call(row,false).ineligibleReason,/开池后参考基准/);
  assert.equal(contract.multiple(row,true),3);
  assert.equal(contract.call(row,true).performanceEligible,true);
});

test('unknown-chain manual repair transfers to the resolved claim atomically',()=>{
  const repo=new Repository(':memory:');
  try{
    const ingestion=new IngestionService(repo),address=a(2);
    ingestion.ingest({source:'telegram',channel:'tg:audit',message:'unknown',at:now(),addresses:[address],sender:'Audit'});
    repo.run("UPDATE jobs SET payload=? WHERE chain='?' AND address=?",JSON.stringify({manual:true,manualBatchId:'audit-manual'}),address);
    ingestion.resolveChain(address,'bsc',{manualBatchId:'audit-manual'});
    const claim=repo.claim('bsc',address);
    const job=repo.get("SELECT payload FROM jobs WHERE lane='capture' AND chain='bsc' AND address=? AND claim_version=? AND state='QUEUED'",address,claim.version);
    assert.ok(job);
    assert.equal(JSON.parse(job.payload).manualBatchId,'audit-manual');
    assert.equal(JSON.parse(job.payload).stage,'baseline');
  }finally{repo.close();}
});

test('Telegram initial-history rejection clears the backfill lock and allows a fresh scan',async()=>{
  const monitor=Object.create(TelegramMonitor.prototype);
  Object.assign(monitor,{state:'connected',client:{},groups:new Map([['1',{peerId:'1',title:'audit'}]]),
    historyByPeer:new Map(),backfillJob:null,enqueueHistory:async()=>0});
  monitor.historyByPeer.set('1',Promise.reject(new Error('initial history network failure')));
  await assert.rejects(monitor.backfillSince(now()-3600),/initial history network failure/);
  assert.equal(monitor.backfillJob,null);
  monitor.historyByPeer.clear();
  assert.deepEqual(await monitor.backfillSince(now()-3600),{groups:1,messages:0});
});

test('WeChat refuses to call an unready selected-group scan complete',async()=>{
  const manager=Object.create(WatchManager.prototype);
  Object.assign(manager,{backfillPromise:undefined,wantedGroups:new Set(['wx-group']),running:new Map([['wx-group',{ready:false}]])});
  await assert.rejects(manager.backfillSince(now()-12*3600),error=>error.code==='WECHAT_NOT_READY');
});

test('historical K lines are split below AVE 300-candle limit and deduplicated',async()=>{
  const acquisition=Object.create(PriceAcquisition.prototype),calls=[];
  acquisition.market={priceBars:async(_provider,_token,from,to,resolution,interval)=>{calls.push({from,to,resolution,interval});return [{time:from,high:2},{time:from,high:3}];}};
  const from=1_000,to=from+300*700;
  const result=await acquisition.historyBars('ave',{chain:'bsc'},from,to,'5m',300);
  assert.equal(calls.length,3);
  assert.ok(calls.every(call=>call.to-call.from<=300*299));
  assert.equal(result.bars.length,3);
  assert.equal(result.bars[0].high,3);
  assert.equal(result.ranges.length,3);
});
function seed(repo,id,{at=now()-22000,metadata={symbol:'AUDIT',name:'Audit'},stage='history',manual=false}={}){
  const address=a(id);
  repo.run('INSERT INTO tokens(chain,address,verified,metadata,last_call) VALUES(?,?,?,?,?)','bsc',address,1,JSON.stringify(metadata),at);
  repo.run('INSERT INTO mentions(source,channel,message,chain,address,sender_key,sender,at,bot,active) VALUES(?,?,?,?,?,?,?,?,0,1)','telegram','tg:audit','seed-'+id,'bsc',address,'telegram:audit','Audit',at);
  const owner=repo.get('SELECT id FROM mentions WHERE address=?',address).id;
  repo.run('INSERT INTO claims(chain,address,owner,version,at,active) VALUES(?,?,?,?,?,1)','bsc',address,owner,1,at);
  repo.run('INSERT INTO results(chain,address,claim_version,status) VALUES(?,?,?,?)','bsc',address,1,'missing_baseline');
  repo.run('INSERT INTO price_results(chain,address,claim_version,baseline,peak,updated_at) VALUES(?,?,?,?,?,?)','bsc',address,1,JSON.stringify({provider:'ave',unit:'price',value:1,price:1,at}),null,at);
  repo.enqueue('capture','bsc',address,1,{stage,...(manual?{manual:true,manualBatchId:'audit-manual',manualAttempts:1}:{})},1,now()-1);
  return address;
}
function services(repo){const ingestion=new IngestionService(repo);const market=new MarketService(repo,{}, {recompute(){},publish(){repo.project();}},ingestion);return {market,ingestion};}
function repeat(ingestion,address){ingestion.ingest({source:'telegram',channel:'tg:audit',message:'repeat-'+address,at:now(),addresses:[address],chain:'bsc',sender:'Audit',senderId:'audit'});}

test('startup extends only queued automatic history jobs from six hours to the current 24-hour window',()=>{
  const repo=new Repository(':memory:');
  try{
    const at=now()-3600,automatic=seed(repo,90,{at}),manual=seed(repo,91,{at,manual:true});
    repo.run("UPDATE jobs SET due=? WHERE address IN(?,?)",at+21600,automatic,manual);
    repo.run("DELETE FROM settings WHERE key='migration.capture-quiet-window-12h-v1'");
    repo.migrate();
    assert.equal(repo.get('SELECT due FROM jobs WHERE address=?',automatic).due,at+CAPTURE_QUIET_WINDOW_SEC);
    assert.equal(repo.get('SELECT due FROM jobs WHERE address=?',manual).due,at+21600);
    assert.equal(repo.setting('migration.capture-quiet-window-12h-v1',null).extended,1);
  }finally{repo.close();}
});

for(const result of ['peak','empty','error'])test(`repeat during ${result} history response preserves completed progress and bounded retries`,async()=>{
  const repo=new Repository(':memory:');let worker;
  try{
    const at=now()-CAPTURE_QUIET_WINDOW_SEC-1000,address=seed(repo,1,{at}),{market,ingestion}=services(repo);
    let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    market.priceBars=async()=>{entered();await gate;if(result==='error')throw Error('provider timeout');return result==='empty'?[]:[{time:at+300,high:2,close:1.5}];};
    worker=new Worker(repo,market.handlers(),{timeoutMs:5000});const job=worker.claim('capture'),running=worker.execute(job);await ready;
    repeat(ingestion,address);release();await running;
    const next=repo.get('SELECT state,payload,due,attempts FROM jobs WHERE id=?',job.id);
    assert.equal(JSON.parse(next.payload).stage,'history');
    if(result==='peak')assert.equal(JSON.parse(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak).multiple,2);
    else assert.equal(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak,null);
    assert.equal(next.state,result==='error'?'BACKOFF':'QUEUED');
    assert.ok(next.due<=now()+900);assert.ok(next.due>now());
    if(result==='error')assert.equal(next.attempts,1);else assert.equal(next.attempts,0);
  }finally{worker?.stop();repo.close();}
});

test('completed history persists its high and schedules the next bounded page',async()=>{
  const repo=new Repository(':memory:');try{
    const at=now()-CAPTURE_QUIET_WINDOW_SEC-1000,address=seed(repo,1,{at}),{market}=services(repo);
    market.priceBars=async()=>[{time:at+300,high:2,close:1.5}];
    const worker=new Worker(repo,market.handlers());await worker.execute(worker.claim('capture'));
    assert.equal(JSON.parse(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak).multiple,2);
    assert.equal(repo.get('SELECT state FROM jobs WHERE address=?',address).state,'QUEUED');assert.ok(repo.get('SELECT due FROM jobs WHERE address=?',address).due<=now()+900);
  }finally{repo.close();}
});

test('active history is captured incrementally before the legacy quiet boundary',async()=>{
  const repo=new Repository(':memory:');try{
    const address=seed(repo,1,{at:now()-3600}),{market}=services(repo);
    let calls=0;market.priceBars=async()=>{calls++;return [];};
    const worker=new Worker(repo,market.handlers());await worker.execute(worker.claim('capture'));
    const next=repo.get('SELECT payload,state,due FROM jobs WHERE address=?',address);
    assert.equal(JSON.parse(next.payload).stage,'history');assert.equal(next.state,'QUEUED');assert.ok(next.due>now());assert.ok(calls>0);assert.ok(next.due<=now()+900);
  }finally{repo.close();}
});

test('explicit manual history remains immediate and keeps its request identity',async()=>{
  const repo=new Repository(':memory:');try{
    const at=now()-3600,address=seed(repo,1,{at,manual:true}),{market}=services(repo);
    market.priceBars=async()=>[{time:at+300,high:2,close:1.5}];
    const worker=new Worker(repo,market.handlers());await worker.execute(worker.claim('capture'));
    const next=repo.get('SELECT payload,state FROM jobs WHERE address=?',address);
    assert.equal(next.state,'DONE');assert.equal(JSON.parse(next.payload).manualBatchId,'audit-manual');
    assert.equal(JSON.parse(repo.get('SELECT peak FROM price_results WHERE address=?',address).peak).multiple,2);
  }finally{repo.close();}
});

test('a later shout already stored does not postpone incremental history',async()=>{
  const repo=new Repository(':memory:');try{
    const address=seed(repo,1),{market}=services(repo);
    repo.run('UPDATE tokens SET last_call=? WHERE address=?',now()-100,address);
    let calls=0;market.priceBars=async()=>{calls++;return [];};
    const worker=new Worker(repo,market.handlers());await worker.execute(worker.claim('capture'));
    const next=repo.get('SELECT state,payload,due FROM jobs WHERE address=?',address);
    assert.equal(next.state,'QUEUED');assert.equal(JSON.parse(next.payload).stage,'history');
    assert.ok(next.due>now());assert.ok(next.due<=now()+900);assert.ok(calls>0);
  }finally{repo.close();}
});

test('historical missing avatars and metadata scan independently of the live inventory',()=>{
  const repo=new Repository(':memory:');try{
    seed(repo,1,{at:now()-2*86400});seed(repo,2,{at:now()});const {market}=services(repo);
    const logos=[],metadata=[];market.refreshMissingLogos=rows=>logos.push(...rows.map(r=>r.address));market.refreshMissingMetadata=rows=>metadata.push(...rows.map(r=>r.address));market.scheduleVisible=()=>{};market.refreshFastMetadata=async()=>{};
    market.active.set('bsc:'+a(2),1);market.refresh();
    assert.equal(market.inventory.size,1);assert.ok(logos.includes(a(1)));assert.ok(metadata.includes(a(1)));
    const before=logos.length;market.refreshHistoricalMetadata();assert.equal(logos.length,before,'historical scan is paced');
  }finally{repo.close();}
});

test('historical cursor serves each eligible row and wraps without starving a page',()=>{
  const repo=new Repository(':memory:');try{
    for(let id=1;id<=3;id++)seed(repo,id,{at:now()-2*86400});const {market}=services(repo),seen=[];
    market.refreshMissingLogos=rows=>seen.push(rows[0].address);market.refreshMissingMetadata=()=>{};
    for(let i=0;i<3;i++){market.lastHistoricalMetadataScan=0;market.refreshHistoricalMetadata();}
    assert.deepEqual(seen,[a(1),a(2),a(3)]);
    market.lastHistoricalMetadataScan=0;market.refreshHistoricalMetadata();assert.equal(market.historicalMetadataCursor,0);
  }finally{repo.close();}
});

test('historical scan reads at most fifty rows, does not rebuild all token views, and yields when lanes are busy',()=>{
  const repo=new Repository(':memory:');try{
    for(let id=1;id<=80;id++)seed(repo,id,{at:now()-2*86400,metadata:{symbol:'T',name:'Token',logo:goodLogo,liq:1,holders:1}});
    const {market}=services(repo);repo.view=()=>{throw Error('full view forbidden');};
    market.refreshHistoricalMetadata();assert.equal(market.historicalMetadataCursor,50);
    market.lastHistoricalMetadataScan=0;market.logoActive.add('busy');market.logoActive.add('busy-2');market.metadataActive.add('busy');market.refreshHistoricalMetadata();assert.equal(market.historicalMetadataCursor,50);
  }finally{repo.close();}
});

test('background metadata retries do not use the paid API',async()=>{
  const repo=new Repository(':memory:');try{
    const address=seed(repo,1),{market}=services(repo);let options;
    market.confirmFromMarket=async(token,ctx,priority,config)=>{options={address:token.address,priority,...config};return true;};
    market.refreshMissingMetadata([repo.tokenByAddress(address,'bsc')]);await Promise.resolve();
    assert.equal(options.allowApi,false);assert.equal(options.priority,'background');
  }finally{repo.close();}
});

test('stored avatar eligibility matches proxy host policy',()=>{
  assert.ok(usableAvatarUrl(goodLogo));assert.ok(usableAvatarUrl('https://cdn.dexscreener.com/token/a.png'));
  for(const url of [oldLogo,'https://files.5pop.com/a.png','http://www.iconaves.com/a','https://www.iconaves.com.evil.test/a','https://u:p@www.iconaves.com/a','https://www.iconaves.com:8443/a','bad'])assert.equal(usableAvatarUrl(url),false,url);
});

test('DEX primary avatar replaces old GMGN metadata without using GMGN or the paid API',async()=>{
  const repo=new Repository(':memory:');try{
    const address=seed(repo,1,{metadata:{symbol:'T',name:'Token',logo:oldLogo}}),{market}=services(repo),requested=[];
    market.quote=async(provider)=>{requested.push(provider);return {logo:goodLogo};};
    await market.lookupLogo(repo.tokenByAddress(address,'bsc'),'bsc:'+address,{});
    const metadata=JSON.parse(repo.get('SELECT metadata FROM tokens WHERE address=?',address).metadata);
    assert.equal(metadata.logo,goodLogo);assert.equal(metadata.sources.logo.provider,'dex');assert.deepEqual(requested,['dex']);
  }finally{repo.close();}
});

test('unsupported returned logos use DEX fallback and failed avatar attempts are bounded',async()=>{
  const repo=new Repository(':memory:'),original=Dex.batchMetadata;try{
    const address=seed(repo,1,{metadata:{symbol:'T',name:'Token',logo:oldLogo}}),{market}=services(repo);
    market.quote=async()=>({logo:oldLogo});Dex.batchMetadata=async()=>new Map([[address,{logo:oldLogo}]]);
    for(let i=0;i<4;i++){
      const token=repo.tokenByAddress(address,'bsc');await market.lookupLogo(token,'bsc:'+address,token.logoLookup||{});
    }
    const token=repo.tokenByAddress(address,'bsc');assert.equal(token.logoLookup.attempts,4);assert.equal(token.logoLookup.nextTryAt,Number.MAX_SAFE_INTEGER);
    market.lookupLogo=()=>{throw Error('fifth retry forbidden');};market.refreshMissingLogos([token]);
    Dex.batchMetadata=async()=>new Map([[address,{logo:goodLogo}]]);
    // A healthy quote can still replace an exhausted avatar without manual retry.
    assert.equal(market.storeLogo(token,'dex',goodLogo),true);
  }finally{Dex.batchMetadata=original;repo.close();}
});

test('failure reports for legacy URLs use current token lookup without waiting for projection',()=>{
  const repo=new Repository(':memory:');try{
    const address=seed(repo,1,{metadata:{symbol:'T',name:'Token',logo:oldLogo}}),{market}=services(repo);
    market.refreshMissingLogos=()=>{};assert.equal(repo.projection('rows',[]).length,0);
    assert.equal(market.reportLogoFailure('bsc',address,oldLogo).ok,true);
    assert.ok(repo.tokenByAddress(address,'bsc').logoLookup.failedUrls.includes(oldLogo));
  }finally{repo.close();}
});

test('expired image failures are cleared when the source becomes reusable again',()=>{
  const repo=new Repository(':memory:');try{
    const address=seed(repo,1,{metadata:{symbol:'T',name:'Token',logo:goodLogo,logoLookup:{failedUrls:[goodLogo],failedAt:{[goodLogo]:now()-22000},lastAttemptAt:now()-22000}}}),{market}=services(repo);
    assert.equal(market.storeLogo(repo.tokenByAddress(address,'bsc'),'ave',goodLogo),true);
    assert.equal(repo.tokenByAddress(address,'bsc').logoLookup.failedUrls.includes(goodLogo),false);
  }finally{repo.close();}
});
