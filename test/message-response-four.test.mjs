import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {WechatWatcher,restoreShardCursors} from '../src/adapters/wechat/watch.ts';
import {dexRequestGate,Dex} from '../src/adapters/core/dex.ts';
import {MarketService} from '../src/services/market.mjs';
import {now} from '../src/domain/rules.mjs';
const a='0x'+'a'.repeat(40),b='0x'+'b'.repeat(40),c='0x'+'c'.repeat(40);
function fixture(){
 const repo=new Repository(':memory:'),w=new WechatWatcher();
 repo.db.exec('CREATE TABLE sample(local_id INTEGER PRIMARY KEY,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT,WCDB_CT_message_content INTEGER,sort_seq INTEGER);CREATE INDEX sample_time ON sample(sort_seq)');
 const put=(id,at,text=a)=>repo.run('INSERT INTO sample VALUES(?,1,?,1,?,0,?)',id,at,text,at*1000);
 w.ensureSender=()=>{};w.formatContent=text=>({sender:'audit',senderId:'one',text});
 const shard={db:repo.db,table:'sample',name2id:new Map(),cursorTime:now()-60,cursorId:-1,arrivalId:0};
 return {repo,w,shard,put};
}
test('a delayed 23-hour-old insert is delivered once while normal messages remain immediate',async()=>{
 const {repo,w,shard,put}=fixture();try{
 const seen=[],receive=e=>seen.push(e.sourceId);put(1,now());await w.drainLiveShard(shard,false,'audit',receive,now()-60);
 assert.equal(seen.length,1);put(2,now()-23*3600,b);await w.drainLiveShard(shard,false,'audit',receive,now()-60);
 await w.drainLiveShard(shard,false,'audit',receive,now()-60);assert.equal(new Set(seen).size,2);assert.equal(seen.length,2);
 put(3,now()-25*3600,c);await w.drainLiveShard(shard,false,'audit',receive,now()-60);assert.equal(seen.length,2);assert.equal(shard.arrivalId,3);
 }finally{repo.close();}
});
test('failed delayed delivery retries without advancing its cursor or suppressing the message',()=>{
 const {repo,w,shard,put}=fixture();try{
 shard.cursorTime=now();put(1,now()-30);assert.throws(()=>w.readArrivals(shard,false,'audit',()=>{throw Error('disk temporarily busy');},now()-60));
 assert.equal(shard.arrivalId,0);let count=0;w.readArrivals(shard,false,'audit',()=>count++,now()-60);assert.equal(count,1);assert.equal(shard.arrivalId,1);
 }finally{repo.close();}
});
test('large delayed bursts are paged and reopening preserves the independent arrival position',()=>{
 const {repo,w,shard,put}=fixture();try{shard.cursorTime=now();for(let i=1;i<=150;i++)put(i,now()-30);
 let count=0;w.readArrivals(shard,false,'audit',()=>count++,now()-60);assert.equal(count,100);
 const restored=restoreShardCursors([{...shard,arrivalId:150}], [{...shard,arrivalId:100}],now()-60)[0];
 w.readArrivals(restored,false,'audit',()=>count++,now()-60);assert.equal(count,150);
 const replacement=restoreShardCursors([{...shard,fileId:'new'}],[{...shard,fileId:'old'}],now()-60)[0];
 assert.ok(replacement.cursorTime<=now()-86400);assert.equal(replacement.cursorId,-1);
 }finally{repo.close();}
});
test('consecutive WeChat edits, restart, and retraction all apply with increasing revisions',()=>{
 const {repo,w,shard,put}=fixture(),ingest=new IngestionService(repo),events=[];
 const receive=e=>{events.push(e);ingest.ingest({...e,group:'audit'});};
 try{put(1,now()-30);w.readPage(shard,false,'audit',receive,now()-60);
 repo.run('UPDATE sample SET message_content=?',b);w.reconcileTrackedCalls(shard,false,'audit',receive);
 repo.run('UPDATE sample SET message_content=?',c);w.reconcileTrackedCalls(shard,false,'audit',receive);
 assert.equal(events.length,3);assert.ok(events[2].messageRevision>events[1].messageRevision);
 assert.deepEqual(JSON.parse(repo.get('SELECT payload FROM messages').payload).addresses,[c]);
 const fresh=new WechatWatcher();fresh.ensureSender=w.ensureSender;fresh.formatContent=w.formatContent;
 const saved=JSON.parse(repo.get('SELECT payload FROM messages').payload);fresh.seedKnownCalls([{...events[2],messageRevision:saved.revision}]);
 repo.run('UPDATE sample SET message_content=?',a);fresh.reconcileTrackedCalls(shard,false,'audit',receive);
 assert.ok(events[3].messageRevision>events[2].messageRevision);
 repo.run('UPDATE sample SET local_type=10002');fresh.reconcileTrackedCalls(shard,false,'audit',receive);
 assert.equal(repo.get('SELECT active FROM messages').active,0);assert.ok(events.at(-1).messageRevision>events[3].messageRevision);
 }finally{repo.close();}
});
test('continuous urgent notifications cannot starve a refresh, while the first blocked request is preempted',async()=>{
 let events,aborts=0,requests=0,rendered=0;const pending=[];
 const window={xray:{onOverlayMode(){}},dispatchEvent(){}};
 const context={window,document:{hidden:false,addEventListener(){},getElementById(){return null;}},location:{pathname:'/overlay'},AbortController,AbortSignal,Date,Map,Set,URLSearchParams,CustomEvent:class{},setTimeout,clearTimeout,setInterval(){},EventSource:class{constructor(){events=this;}},fetch:(url,options)=>url.startsWith('/api/token-updates')?new Promise((resolve,reject)=>{requests++;pending.push(()=>resolve({ok:true,json:async()=>({reset:true,removed:[],changed:[{key:'audit'}],revision:requests})}));options.signal.addEventListener('abort',()=>{aborts++;reject(Error('aborted'));});}):Promise.resolve({ok:true,json:async()=>({settings:{monitor:{wechat:[],telegram:[]},opacity:1}})})};
 vm.runInNewContext(fs.readFileSync(new URL('../src/ui/ui-bridge.js',import.meta.url),'utf8'),context);window.fomomo.onState(()=>rendered++);
 const notify=()=>events.onmessage({data:'{"urgent":true,"wake":false}'});
 await notify();await new Promise(setImmediate);assert.equal(aborts,1);
 for(let i=0;i<50;i++)await notify();assert.equal(requests,2);assert.equal(aborts,1);
 pending[1]();await new Promise(setImmediate);assert.equal(rendered,1);assert.equal(requests,3);
 for(let i=0;i<50;i++)await notify();assert.equal(aborts,1);pending[2]();await new Promise(setImmediate);assert.equal(rendered,2);
 pending.at(-1)();await new Promise(setImmediate);
});
test('new CA starts in the reserved DEX slot even when regular traffic is full',async()=>{
 const releases=[],started=[];const regular=Array.from({length:4},(_,i)=>dexRequestGate.run('audit-old-'+i,'live',()=>{started.push('old'+i);return new Promise(resolve=>releases.push(resolve));}));
 await new Promise(setImmediate);assert.equal(started.length,3);
 const urgent=dexRequestGate.run('audit-new','new-call',async()=>{started.push('new');});await urgent;
 assert.equal(started.at(-1),'new');assert.ok(!started.includes('old3'));
 releases.splice(0).forEach(resolve=>resolve());await new Promise(setImmediate);releases.splice(0).forEach(resolve=>resolve());await Promise.all(regular);
});
test('new CA metadata carries urgent priority and offscreen quotes retain background priority',async()=>{
 const repo=new Repository(':memory:'),ingestion=new IngestionService(repo),market=new MarketService(repo,{}, {},ingestion),seen=[];
 const savedMetadata=Dex.batchMetadata,savedBatch=Dex.batch;
 try{ingestion.ingest({group:'audit',sourceId:'one',time:now(),chainHint:'bsc',addrs:[a],sender:'audit'});market.stopped=false;
 Dex.batchMetadata=async(chain,addresses,priority)=>{seen.push(priority);return new Map();};
 await market.refreshFastMetadata(['bsc:'+a],{priority:'new-call'});assert.deepEqual(seen,['new-call']);
 Dex.batch=async(chain,addresses,priority)=>{seen.push(priority);return new Map();};market.recordLive=()=>{};market.noteLiveProviderFailure=()=>{};market.refreshAveSupplement=async()=>{};
 const token=repo.claim('bsc',a);await market.refreshDexBackgroundBatch('bsc',[{token,key:'bsc:'+a,generation:1}]);assert.equal(seen[1],'background');
 }finally{Dex.batchMetadata=savedMetadata;Dex.batch=savedBatch;market.stop();repo.close();}
});
