import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {Collectors} from '../src/services/collectors.mjs';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {MarketService} from '../src/services/market.mjs';
import {DashboardContract} from '../src/services/dashboard-contract.mjs';
import {WaitError,isTransientMarketError,Worker} from '../src/infra/worker.mjs';
import {requestJson} from '../src/adapters/core/proxy.ts';
import {RequestScheduler} from '../src/adapters/core/request-scheduler.ts';
import {TelegramMonitor} from '../src/adapters/telegram/monitor.ts';
import {WechatWatcher} from '../src/adapters/wechat/watch.ts';
const address='0x1111111111111111111111111111111111111111';
const now=()=>Math.floor(Date.now()/1000);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function setup(){const repo=new Repository(':memory:');const ingestion=new IngestionService(repo);ingestion.ingest({source:'telegram',channel:'tg:audit',message:'one',at:now()-10,chain:'bsc',addresses:[address],sender:'s'});return {repo,ingestion};}
test('pending CA remains visible after 61 seconds and after reopening',()=>{
 const s=fs.readFileSync(new URL('../src/ui/overlay.js',import.meta.url),'utf8');const filter=s.slice(s.indexOf('  function filteredTokens()'),s.indexOf('  function latestMentionTime('));
 for(const age of [61,3600])assert.equal(vm.runInNewContext(filter+';filteredTokens().length',{state:{query:'',now:now(),tokens:[{chain:'?',pending:true,firstSeen:now()-age}],peakMultipleSort:'off'},pickChain:t=>t.chain,latestMentionTime:t=>t.firstSeen}),1);
});
test('repeat without baseline remains immediately eligible; credential and cooldown waits survive',()=>{
 for(const state of ['PARKED','BACKOFF']){const {repo,ingestion}=setup();try{
  repo.run('UPDATE jobs SET state=?,wait=?,due=?',state,state==='PARKED'?'ave_api_key':null,now()+30);
  ingestion.ingest({source:'telegram',channel:'tg:audit',message:'two',at:now(),chain:'bsc',addresses:[address],sender:'s'});
  assert.equal(repo.get('SELECT state FROM jobs').state,state);
 }finally{repo.close()}}
 const {repo,ingestion}=setup();try{
  repo.run("UPDATE jobs SET state='PARKED',wait='nodata'");
  ingestion.ingest({source:'telegram',channel:'tg:audit',message:'two',at:now(),chain:'bsc',addresses:[address],sender:'s'});
  const job=repo.get('SELECT * FROM jobs');assert.equal(job.state,'PARKED');assert.equal(job.wait,'nodata');
 }finally{repo.close()}
});
test('temporary chain lookup failures remain reviewable and retry later',async()=>{
 const {repo,ingestion}=setup();try{
  const market=new MarketService(repo,{}, {},ingestion),unknown='0x2222222222222222222222222222222222222222';
  ingestion.ingest({source:'telegram',channel:'tg:audit',message:'unknown',at:now(),addresses:[unknown],sender:'s'});
  let pageCalls=0,dexCalls=0;
  market.prioritizeUnknownWalletAudit=()=>{};market.chainProbes={avePageSearch:async()=>{pageCalls++;throw Error('page timeout')},dex:async()=>{dexCalls++;throw Error('dex timeout')}};
  assert.equal((await market.resolveUnknownChain(unknown)).review,true);
  assert.equal((await market.resolveUnknownChain(unknown)).review,true);
  assert.equal(pageCalls,1);assert.equal(dexCalls,1);
  const metadata=JSON.parse(repo.get("SELECT metadata FROM tokens WHERE chain='?' AND address=?",unknown).metadata);
  assert.equal(metadata.aveChainLookup.status,'no_match');
  assert.equal(metadata.chainResolutionFallback.complete,false);
  assert.ok(metadata.chainResolutionFallback.retryAt>now());
 }finally{repo.close()}
});
test('manual batch pauses for key, blocks duplicate batch, then resumes same identity',()=>{
 const {repo,ingestion}=setup();try{
  const dash=new DashboardContract(repo,{},new MarketService(repo,{}, {},ingestion),{},()=>{});
  repo.run("UPDATE jobs SET state='PARKED',wait='ave_api_key',payload=?",JSON.stringify({manual:true,manualBatchId:'audit'}));
  repo.set('manualRepairBatchV1',{id:'audit',status:'running',startedAt:now(),total:1});
  assert.equal(dash.repairSnapshot().phase,'waiting');assert.equal(repo.setting('manualRepairBatchV1',{}).status,'running');assert.equal(dash.startManualRepairBatch().accepted,false);
  repo.run("UPDATE jobs SET state='QUEUED',wait=NULL");assert.equal(dash.repairSnapshot().running,true);assert.equal(dash.repairSnapshot().runId,'audit');
  repo.run("UPDATE jobs SET state='PARKED',wait='nodata'");assert.equal(dash.repairSnapshot().phase,'complete');
 }finally{repo.close()}
});
test('network reset preserves code and is retryable',async()=>{
 const original=https.request;
 https.request=()=>{const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{req.emit('error',Object.assign(new Error('socket reset'),{code:'ECONNRESET'}));req.emit('close')});req.destroy=()=>req.emit('close');return req};
 try{await assert.rejects(requestJson('https://audit.invalid',{timeoutMs:100}),e=>e.code==='ECONNRESET'&&isTransientMarketError(e));}finally{https.request=original}
});
test('cancelled queued request never executes and shared request survives one caller cancelling',async()=>{
 const gate=new RequestScheduler('audit',1,1,5000,1);let release;
 const blocking=gate.run('block','live',()=>new Promise(r=>release=r));await pause(0);
 const c=new AbortController();let calls=0;
 const cancelled=gate.run('cancel','background',async()=>{calls++;return 1},0,{bucket:'audit',intervalMs:0,signal:c.signal});
 const rejection=assert.rejects(cancelled);c.abort();await rejection;release(1);await blocking;await pause(10);assert.equal(calls,0);
 const owner=new AbortController();let finish,sharedCalls=0;
 const first=gate.run('shared','live',signal=>new Promise((r,j)=>{sharedCalls++;finish=r;signal.addEventListener('abort',()=>j(signal.reason))}),0,{bucket:'audit',intervalMs:0,signal:owner.signal});
 const second=gate.run('shared','live',async()=>99);const firstRejected=assert.rejects(first);await pause(0);owner.abort();await firstRejected;finish(7);assert.equal(await second,7);assert.equal(sharedCalls,1);
});
test('all callers cancelling aborts underlying running request',async()=>{
 const gate=new RequestScheduler('audit',1,1,5000),c=new AbortController();let aborted=false;
 const p=gate.run('running','live',signal=>new Promise((r,j)=>signal.addEventListener('abort',()=>{aborted=true;j(signal.reason)})),0,{bucket:'audit',intervalMs:0,signal:c.signal});
 const rejected=assert.rejects(p);await pause(0);c.abort();await rejected;await pause(0);assert.equal(aborted,true);
});
test('collector persists processing failures and commits the cursor only after successful replay',()=>{
 const repo=new Repository(':memory:'),ingestion=new IngestionService(repo),c=new Collectors(repo,ingestion);
 try{c.delivery.spoolFile=undefined;c.windows.configure({wechat:['g'],telegram:[]});
 const ingest=ingestion.ingest.bind(ingestion);let fail=true;ingestion.ingest=m=>{if(fail)throw Error('DB write');return ingest(m);};
 const before=c.windows.windows.g.lastSeen;c.wechat.forward({group:'g',sourceId:'audit',sender:'s',time:now(),addrs:[address]});
 assert.equal(c.delivery.status().inbox,1);assert.equal(c.windows.windows.g.lastSeen,before);
 fail=false;repo.run('UPDATE delivery_inbox SET due=0');c.delivery.drainInbox();assert.equal(c.delivery.status().inbox,0);assert.equal(repo.get('SELECT active FROM messages').active,1);assert.ok(c.windows.windows.g.lastSeen>before);
 }finally{repo.close();}
});

test('WeChat cursor stays unchanged when delivery fails',()=>{
 const watcher=Object.create(WechatWatcher.prototype);watcher.ensureSender=()=>{};watcher.formatContent=()=>({sender:'s',senderId:'s',text:address});watcher.trackCall=()=>{};watcher.reconcileTrackedCalls=()=>{};
 const shard={cursorTime:now()-10,cursorId:-1,db:{name:'audit.sqlite',prepare:()=>({all:()=>[{local_id:1,local_type:1,create_time:now(),real_sender_id:1,message_content:address,WCDB_CT_message_content:0}]})}};
 const before=shard.cursorTime;assert.throws(()=>watcher.readPage(shard,false,'s',()=>{throw Error('DB write')},now()-20),/DB write/);assert.equal(shard.cursorTime,before);assert.equal(shard.cursorId,-1);
});
test('Telegram commits seen state after successful delivery and retries transient failure',async()=>{
 let calls=0;const tg=new TelegramMonitor(()=>{calls++;if(calls===1)throw Error('DB write')});tg.client={};tg.groups=new Map([['1',{}]]);
 const message={chat:{type:'chat',isGroup:true,chatType:'group',id:1},id:1,date:new Date(),sender:{type:'user',id:1,displayName:'s',username:'',isBot:false},text:address};
 assert.equal(await tg.receiveWithRetry(message,false),true);assert.equal(calls,2);assert.equal(await tg.receive(message,false),false);assert.equal(calls,2);
 tg.client=null;
});
