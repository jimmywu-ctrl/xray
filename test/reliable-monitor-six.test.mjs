import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {Repository} from '../src/infra/database.mjs';
import {ReliableDelivery} from '../src/services/reliable-delivery.mjs';
import {Collectors} from '../src/services/collectors.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {WatchManager} from '../src/adapters/core/watchers.ts';
import {TelegramBotPublisher} from '../src/adapters/telegram/bot-api.ts';
import {now} from '../src/domain/rules.mjs';
const address='0x'+'6'.repeat(40), address2='0x'+'7'.repeat(40);
const message=(id,extra={})=>({group:'tg:123',sourceId:id,sender:'A',senderId:'12',text:address,addrs:[address],time:now(),...extra});

test('inbox survives restart and repeated failures; edits remain behind the failed create',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xray-delivery-')),file=path.join(dir,'test.sqlite');
 let repo=new Repository(file),fail=true;const seen=[];
 const process=m=>{if(fail)throw Error('simulated database outage');seen.push(m.messageEvent||'create');};
 let d=new ReliableDelivery(repo,process,async()=>{});
 d.receive(message('one'));d.receive(message('one',{messageEvent:'edit',messageRevision:Date.now()+1}));
 for(let i=0;i<5;i++){repo.run('UPDATE delivery_inbox SET due=0');d.drainInbox();}
 assert.equal(d.status().inbox,2);assert.deepEqual(seen,[]);repo.close();
 repo=new Repository(file);d=new ReliableDelivery(repo,process,async()=>{});fail=false;
 repo.run('UPDATE delivery_inbox SET due=0');d.drainInbox();d.drainInbox();
 assert.deepEqual(seen,['create','edit']);assert.equal(d.status().inbox,0);
 repo.close();fs.rmSync(dir,{recursive:true});
});

test('failed SQLite insertion falls back to a flushed file and is replayed once',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xray-spool-')),repo=new Repository(':memory:');
 try{let count=0;const d=new ReliableDelivery(repo,()=>count++,async()=>{},path.join(dir,'fallback.jsonl'));
 const original=repo.run.bind(repo);repo.run=(sql,...args)=>{if(sql.startsWith('INSERT OR IGNORE INTO delivery_inbox'))throw Error('busy');return original(sql,...args);};
 d.receive(message('spool'));assert.equal(count,0);assert.ok(fs.statSync(d.spoolFile).size>0);
 repo.run=original;d.drainInbox();d.drainInbox();assert.equal(count,1);assert.equal(fs.readFileSync(d.spoolFile,'utf8'),'');
 }finally{repo.close();fs.rmSync(dir,{recursive:true});}
});

test('outbox retries transport errors, persists receipts, and removes superseded addresses',async()=>{
 const repo=new Repository(':memory:');try{let fail=true,sent=0;
 const d=new ReliableDelivery(repo,()=>{},async()=>{if(fail)throw Error('network disconnected');sent++;});d.stopped=false;
 d.queuePush('stream',address,{},'target');await d.drainOutbox();assert.equal(d.status().outbox,1);
 fail=false;repo.run('UPDATE delivery_outbox SET due=0');await d.drainOutbox();assert.equal(sent,1);
 d.queuePush('stream',address,{},'target');assert.equal(d.status().outbox,0);
 d.queuePush('stream',address2,{},'target');d.cancelPushes('stream',[]);assert.equal(d.status().outbox,0);
 }finally{repo.close();}
});

test('WeChat edits cannot bypass sender selection, but accepted history remains editable',()=>{
 const seen=[],w=new WatchManager(now(),m=>seen.push(m.sourceId),()=>{});
 w.senderFilters={g:{includeSenderIds:['allowed'],blockedSenderIds:[]}};
 w.forward({...message('blocked'),group:'g',senderId:'other',messageEvent:'edit'});
 w.forward({...message('accepted'),group:'g',senderId:'allowed'});
 w.forward({...message('accepted'),group:'g',senderId:'other',messageEvent:'retract'});
 w.knownMessageAccepted=(g,id)=>id==='persisted';
 w.forward({...message('persisted'),group:'g',senderId:'other',messageEvent:'edit'});
 assert.deepEqual(seen,['accepted','accepted','persisted']);
});

test('new groups read 24 hours and additions during a paused backfill schedule a second pass',async()=>{
 const repo=new Repository(':memory:');const c=new Collectors(repo,new IngestionService(repo));
 try{c.wechat.sync=()=>{};c.telegram.sync=()=>{};c.telegram.status=()=>({state:'connected'});
 let finish;const starts=[];c.telegram.backfillSince=from=>{starts.push(from);return new Promise(resolve=>finish=resolve);};
 c.update({wechat:[],telegram:[{peerId:'123',title:'one'}]});
 assert.ok(starts[0]<=now()-86400+1);assert.ok(c.windows.accepts(message('23h',{time:now()-23*3600})));
 c.update({wechat:[],telegram:[{peerId:'123',title:'one'},{peerId:'456',title:'two'}]});
 finish({waiting:true});await new Promise(setImmediate);
 c.runBackfill('telegram','24h',true);finish({waiting:false});await new Promise(setImmediate);
 assert.equal(c.startupBackfillPending.has('telegram'),true);assert.equal(c.backfillStatus.telegram.status,'waiting');
 assert.ok(c.backfillTimers.telegram);
 }finally{for(const t of Object.values(c.backfillTimers))clearTimeout(t);await c.delivery.stop();repo.close();}
});

test('collector queues only new live addresses on edits and cancels deleted addresses',()=>{
 const repo=new Repository(':memory:');const c=new Collectors(repo,new IngestionService(repo));
 try{c.windows.configure({wechat:[],telegram:[{peerId:'123'}]});c.publisher.canPublish=()=>true;c.publisher.status=()=>({target:'fake'});
 // Public monitor callback is constructor-injected and intentionally exercised through the inbox.
 const live={...message('editing'),_deliveryLive:true};c.delivery.receive(live);
 assert.equal(c.delivery.status().outbox,1);
 c.delivery.receive({...live,messageEvent:'edit',messageRevision:Date.now()+10,addrs:[address,address2]});
 assert.equal(c.delivery.status().outbox,2);
 c.delivery.receive({...live,messageEvent:'edit',messageRevision:Date.now()+20,addrs:[address2]});
 assert.equal(c.delivery.status().outbox,1);assert.equal(repo.get('SELECT address FROM delivery_outbox').address,address2);
 c.delivery.receive({...live,messageEvent:'delete',messageRevision:Date.now()+30,addrs:[]});assert.equal(c.delivery.status().outbox,0);
 }finally{repo.close();}
});

test('publisher exposes send failure to its outbox instead of silently succeeding',async()=>{
 const p=new TelegramBotPublisher();p.config={enabled:true,token:'fake',target:'456',filters:[{groupId:'123',senders:[{id:'12'}]}]};
 p.getBotId=async()=> '999';p.getTarget=async()=>({});p.sendMessage=async()=>{throw Error('simulated send failure');};
 await assert.rejects(p.publish({...message('bot'),address,symbol:'TEST',group:'123'}),/simulated send failure/);
});

test('new live CA requests wake; metadata and old history do not wake the overlay',()=>{
 const repo=new Repository(':memory:'),changes=[],ingestion=new IngestionService(repo,o=>changes.push(o));
 try{ingestion.ingest({...message('wake'),addresses:[address]});assert.equal(changes.at(-1).wake,true);
 ingestion.ingest({...message('wake'),addresses:[address],messageEvent:'edit',messageRevision:Date.now()+20});assert.equal(changes.at(-1).wake,false);
 ingestion.ingest({...message('history'),time:now()-3600,addresses:[address2],backfill:true});assert.equal(changes.at(-1),undefined);
 }finally{repo.close();}
});

test('urgent SSE aborts a stalled fetch immediately without marking disconnected or waking on metadata',async()=>{
 const pending=[],statuses=[];let events,wakes=0;
 const document={hidden:false,addEventListener(){},getElementById(){return null;}};
 const window={xray:{onOverlayMode(){},wakeOverlayForUrgent:async()=>{wakes++;}},dispatchEvent(){}};
 const context={window,document,location:{pathname:'/overlay'},AbortController,AbortSignal,Date,Map,Set,URLSearchParams,
 CustomEvent:class{},setTimeout,clearTimeout,setInterval(){},EventSource:class{constructor(){events=this;}},
 fetch:(url,options)=>url.startsWith('/api/token-updates')?new Promise((resolve,reject)=>{pending.push({resolve,options});options.signal.addEventListener('abort',()=>reject(Error('aborted')));}):Promise.resolve({ok:true,json:async()=>({settings:{monitor:{wechat:[],telegram:[]},opacity:1}})})};
 vm.runInNewContext(fs.readFileSync(new URL('../src/ui/ui-bridge.js',import.meta.url),'utf8'),context);
 window.fomomo.onStatus(s=>statuses.push(s));window.fomomo.onState(()=>{});assert.equal(pending.length,1);
 await events.onmessage({data:JSON.stringify({urgent:true,wake:false})});await new Promise(setImmediate);
 assert.equal(pending[0].options.signal.aborted,true);assert.equal(pending.length,2);assert.equal(wakes,0);
 assert.ok(!statuses.some(s=>s.link==='disconnected'));
 pending[1].resolve({ok:true,json:async()=>({reset:true,removed:[],changed:[],revision:1})});await new Promise(setImmediate);
 await events.onmessage({data:JSON.stringify({urgent:true,wake:true})});assert.equal(wakes,1);
 pending.at(-1).resolve({ok:true,json:async()=>({reset:false,removed:[],changed:[],revision:1})});
});
