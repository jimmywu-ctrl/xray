import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MarketService,mergeLiveQuote,primaryDexQuote} from '../src/services/market.mjs';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {CaptureWindows} from '../src/services/capture-windows.mjs';
import {DashboardContract} from '../src/services/dashboard-contract.mjs';
import {Dex} from '../src/adapters/core/dex.ts';
import {WechatWatcher} from '../src/adapters/wechat/watch.ts';
import {diagnoseWechatDbDirectories} from '../src/adapters/config.ts';
import {now,RECENT_WINDOW_SEC,CAPTURE_REFRESH_INTERVAL_SEC} from '../src/domain/rules.mjs';

const token={chain:'bsc',address:'0x'+'5'.repeat(40),version:1,lastCall:now()};
const key=token.chain+':'+token.address;
function marketStub(){return new MarketService({diagnostic(){},current(){return true;},setting(k,f){return k==='logoLookupStrategyVersion'?11:f;}},{},{},{});}
function quote(provider,price,at=now()){return {provider,source:provider,price,mc:price*1000,receivedAt:at,fieldSources:{price:{provider,at},mc:{provider,at}}};}

test('rolling capture includes 23-hour-old messages and bounds restart cursors at 24 hours',()=>{
  assert.equal(RECENT_WINDOW_SEC,86400);
  const repo=new Repository(':memory:');
  try{
    repo.set('captureWindows',{g:{enabledAt:now()-200000,lastSeen:now()-150000}});
    const w=new CaptureWindows(repo);assert.ok(w.startAt('g')>=now()-86400);
    const ingestion=new IngestionService(repo);
    ingestion.ingest({source:'telegram',channel:'tg:test',message:'old',at:now()-23*3600,chain:'bsc',addresses:[token.address],sender:'A'});
    repo.run('UPDATE tokens SET verified=1');
    assert.equal(repo.view({since:now()-RECENT_WINDOW_SEC}).length,1);
  }finally{repo.close();}
});

test('fresh AVE fallback replaces old AVE fields while fresh DEX fields remain primary',()=>{
  const old=quote('ave',1,now()-10),fresh=quote('ave',2);
  assert.equal(mergeLiveQuote(primaryDexQuote(old),fresh,{quote:old}).price,2);
  const dex=quote('dex',3);
  assert.equal(mergeLiveQuote(primaryDexQuote(dex),fresh,{quote:dex}).price,3);
});

test('DEX empty reply cannot count cached AVE data as a fresh DEX success',async()=>{
  const m=marketStub(),original=Dex.batch;let records=0,success=0,failures=0;
  try{
    m.live.set(key,{version:1,quote:quote('ave',1,now()-10)});
    Dex.batch=async()=>new Map();m.recordLive=()=>records++;m.noteLiveProviderSuccess=()=>success++;
    m.noteLiveProviderFailure=()=>failures++;m.refreshAveSupplement=()=>{};
    await m.refreshDexBackgroundBatch('bsc',[{token,key,generation:1}]);
    assert.equal(records,0);assert.equal(success,0);assert.equal(failures,1);
  }finally{Dex.batch=original;}
});

test('live no-data suspension expires automatically without another shout',()=>{
  const m=marketStub();for(let n=0;n<3;n++)m.noteLiveProviderFailure(token,'ave','未返回有效价格');
  const s=m.liveProviderFailures.get(key+'|ave');assert.ok(Number.isFinite(s.retryAt));
  assert.equal(m.liveProviderFailureCount(key,'ave',token),3);
  s.retryAt=Date.now()-1;
  assert.equal(m.liveProviderFailureCount(key,'ave',token),0);
  assert.equal(m.aveSupplementRetryAt.has(key),false);
});

test('fresh fallback is actually published even if a previous AVE quote exists',async()=>{
  const m=marketStub();let result;
  m.live.set(key,{version:1,quote:quote('ave',1,now()-10)});
  m.aveLiveSupplementQueue.set(key,{item:{token,key,generation:1},dexErrors:[]});
  m.quote=async()=>quote('ave',2);m.recordLive=(_t,_p,_g,q)=>result=q;
  await m.drainAveLiveSupplementQueue();assert.equal(result.price,2);
});

test('WeChat readiness requires successful polling and a current database',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'xray-health-'));const file=path.join(tmp,'message_0.db');
  try{
    fs.writeFileSync(file,'fixture');const w=Object.create(WechatWatcher.prototype);
    Object.assign(w,{shards:[{db:{name:file}}],stopped:false,lastReadAt:0,polls:0,latestMessageAt:0});
    assert.equal(w.ready,false);w.lastReadAt=Date.now();assert.equal(w.ready,true);
    const old=new Date(Date.now()-25*3600_000);fs.utimesSync(file,old,old);assert.equal(w.ready,false);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('automatic WeChat discovery prefers the actively updated store',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'xray-discovery-'));
  try{
    const dirs=['xwechat_files','Documents/xwechat_files'].map(p=>path.join(tmp,p,'account','db_storage'));
    for(const dir of dirs){fs.mkdirSync(path.join(dir,'message'),{recursive:true});fs.writeFileSync(path.join(dir,'message','message_0.db'),'fixture');}
    const old=new Date(Date.now()-9*86400_000);fs.utimesSync(path.join(dirs[0],'message','message_0.db'),old,old);
    const d=diagnoseWechatDbDirectories({homeDir:tmp,env:{USERPROFILE:tmp,APPDATA:path.join(tmp,'appdata')}});
    assert.equal(d.detectedDbDir,dirs[1]);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('network-failed captures and future quiet-window jobs are recovered once',()=>{
  const repo=new Repository(':memory:');
  try{
    new IngestionService(repo).ingest({source:'telegram',channel:'tg:test',message:'recover',at:now()-1800,chain:'bsc',addresses:[token.address],sender:'A'});
    repo.run("UPDATE jobs SET state='FAILED',last_error='net::ERR_CONNECTION_CLOSED',attempts=1");
    repo.run("DELETE FROM settings WHERE key='migration.monitor-repair-24h-v1'");repo.migrate();
    const j=repo.get('SELECT * FROM jobs');assert.equal(j.state,'BACKOFF');assert.equal(j.attempts,0);
    assert.equal(repo.setting('migration.monitor-repair-24h-v1').recovered,1);
    repo.run("UPDATE jobs SET state='FAILED'");repo.migrate();assert.equal(repo.get('SELECT state FROM jobs').state,'FAILED');
  }finally{repo.close();}
});

test('active tokens capture history incrementally despite a recent repeat shout',async()=>{
  const repo=new Repository(':memory:');
  try{
    const ingestion=new IngestionService(repo),at=Math.floor((now()-3600)/300)*300;
    ingestion.ingest({source:'telegram',channel:'tg:test',message:'history',at,chain:'bsc',addresses:[token.address],sender:'A'});
    repo.run('UPDATE tokens SET verified=1,last_call=?',now());
    const t=repo.claim('bsc',token.address);
    repo.run('INSERT INTO price_results(chain,address,claim_version,baseline,updated_at) VALUES(?,?,?,?,?)','bsc',token.address,t.version,JSON.stringify({provider:'ave',unit:'price',value:1,price:1,at:at-1}),now());
    const m=new MarketService(repo,{}, {publish(){},recompute(){}},ingestion);
    m.priceBars=async(_p,_t,from)=>[{time:Math.ceil(from/300)*300,high:2,close:1.5}];
    const result=await m.priceAcquisition.history({job:{chain:'bsc',address:token.address,payload:{stage:'history'}},guard:()=>true});
    assert.ok(repo.get('SELECT peak FROM price_results').peak);
    assert.equal(result.again,CAPTURE_REFRESH_INTERVAL_SEC);
  }finally{repo.close();}
});

test('cached quote timestamps cannot become fresh merely by being stored again',()=>{
  const m=marketStub(),old=now()-20;m.repo.run=()=>{};m.recordObservedPeak=()=>{};
  const entry=m.recordLive(token,'ave',1,quote('ave',1,old));assert.equal(entry.receivedAt,old);
});

test('a first DEX identity does not wait for missing AVE metadata',async()=>{
  const repo=new Repository(':memory:');
  try{
    const ingestion=new IngestionService(repo);
    ingestion.ingest({source:'telegram',channel:'tg:test',message:'identity',at:now()-60,chain:'bsc',addresses:[token.address],sender:'A'});
    const m=new MarketService(repo,{}, {},ingestion),calls=[];
    m.quote=async provider=>{calls.push(provider);assert.equal(provider,'dex');return {chain:'bsc',symbol:'T',name:'Token',price:1,mc:1000};};
    await m.confirmFromMarket(repo.claim('bsc',token.address),{guard:()=>true},'live');
    assert.deepEqual(calls,['dex']);assert.equal(repo.get('SELECT verified FROM tokens').verified,1);
  }finally{repo.close();}
});

test('post-call launch references cannot masquerade as first-call returns',()=>{
  const repo=new Repository(':memory:');
  try{
    const ingestion=new IngestionService(repo),at=now()-600;
    ingestion.ingest({source:'telegram',channel:'tg:test',message:'launch',at,chain:'bsc',addresses:[token.address],sender:'A'});
    repo.run('UPDATE tokens SET verified=1');const t=repo.claim('bsc',token.address);
    repo.run('INSERT INTO price_results(chain,address,claim_version,baseline,updated_at) VALUES(?,?,?,?,?)','bsc',token.address,t.version,JSON.stringify({provider:'ave',price:1,value:1,at:at+60,approximate:true,origin:'first-traded-candle-after-call'}),now());
    const m=new MarketService(repo,{}, {},ingestion);m.liveQuote=()=>({version:t.version,provider:'dex',quote:quote('dex',2),receivedAt:now()});
    const d=new DashboardContract(repo,{},m,{},()=>{});assert.equal(d.tokens()[0].currentMultiple,null);
  }finally{repo.close();}
});

test('exhausted historical transport errors receive finite low-frequency rechecks',()=>{
  const repo=new Repository(':memory:');
  try{
    const ingestion=new IngestionService(repo);
    ingestion.ingest({source:'telegram',channel:'tg:test',message:'recheck',at:now()-3600,chain:'bsc',addresses:[token.address],sender:'A'});
    repo.run('UPDATE tokens SET verified=1');repo.run("UPDATE jobs SET state='PARKED',wait='limit',updated_at=?,payload=?",now()-1900,JSON.stringify({failureAttempts:3}));
    const m=new MarketService(repo,{}, {},ingestion);m.scheduleNoDataRetries();
    let row=repo.get('SELECT * FROM jobs');assert.equal(row.state,'QUEUED');
    let p=JSON.parse(row.payload);assert.equal(p.automaticRechecks,1);assert.equal(p.failureAttempts,0);
    p.automaticRechecks=4;p.nextNoDataRetryAt=now()-1;repo.run("UPDATE jobs SET state='PARKED',wait='limit',payload=?",JSON.stringify(p));
    m.lastNoDataRetryScan=0;m.scheduleNoDataRetries();assert.equal(repo.get('SELECT state FROM jobs').state,'PARKED');
  }finally{repo.close();}
});

test('a deferred empty baseline keeps its retry outcome instead of entering history without a baseline',async()=>{
  const repo=new Repository(':memory:');
  try{
    const ingestion=new IngestionService(repo);
    ingestion.ingest({source:'telegram',channel:'tg:test',message:'empty-first',at:now()-60,chain:'bsc',addresses:[token.address],sender:'A'});
    const m=new MarketService(repo,{}, {},ingestion);
    m.priceAcquisition.baseline=async()=>({again:300,payload:{stage:'baseline',baselineEmptyAttempts:1}});
    m.priceAcquisition.history=async()=>{throw Error('must not enter history before baseline exists');};
    const result=await m.capture({job:{chain:'bsc',address:token.address,payload:{stage:'history'}},guard:()=>true});
    assert.equal(result.again,300);assert.equal(result.payload.stage,'baseline');
  }finally{repo.close();}
});

test('a known-chain wallet stays archived when mentioned again and retains source messages',()=>{
  const repo=new Repository(':memory:');
  try{
    const ingestion=new IngestionService(repo),at=now()-60;
    const msg={source:'telegram',channel:'tg:test',chain:'eth',addresses:[token.address],sender:'A'};
    ingestion.ingest({...msg,message:'wallet-first',at});
    ingestion.markUnknownWallet(token.address,{automatic:true,evidence:{kind:'wallet',network:'eth',nonce:'1',reason:'fixture outgoing transaction'}});
    ingestion.ingest({...msg,message:'wallet-repeat',at:at+30});
    const row=repo.get('SELECT metadata FROM tokens');assert.equal(JSON.parse(row.metadata).autoDisposition,'wallet');
    assert.equal(repo.get('SELECT wait FROM jobs').wait,'manual_wallet');
    assert.equal(repo.get('SELECT COUNT(*) n FROM mentions WHERE active=1').n,2);
  }finally{repo.close();}
});
