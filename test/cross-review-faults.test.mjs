import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {get} from 'node:http';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {MarketService} from '../src/services/market.mjs';
import {Collectors} from '../src/services/collectors.mjs';
import {Worker} from '../src/infra/worker.mjs';
import {BackgroundProjection} from '../src/infra/background-projection.mjs';
import {createServer} from '../src/server.mjs';
import {now} from '../src/domain/rules.mjs';
const ca=i=>'0x'+i.toString(16).padStart(40,'0');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function seeded(){const repo=new Repository(':memory:'),ingestion=new IngestionService(repo);ingestion.ingest({group:'tg:123',sourceId:'one',time:now()-100,chainHint:'bsc',addrs:[ca(1)],sender:'audit'});return {repo,ingestion,token:repo.claim('bsc',ca(1))};}

for(const outcome of ['resolve','reject'])test(`metadata ${outcome} after shutdown cannot access a closed database`,async()=>{
 const {repo,ingestion,token}=seeded(),market=new MarketService(repo,{}, {},ingestion);let release;
 market.quote=()=>new Promise((resolve,reject)=>{release=()=>outcome==='reject'?reject(Error('connection reset')):resolve({price:1,symbol:'AUDIT'});});
 const work=market.confirmFromMarket(token,{guard:()=>true});market.stop();repo.close();release();assert.equal(await work,false);assert.equal(market.metadataActive.size,0);
});

test('an avatar response after shutdown cannot write a late result or a retry diagnostic',async()=>{
 const {repo,ingestion,token}=seeded(),market=new MarketService(repo,{}, {},ingestion);let release;
 market.quote=()=>new Promise(resolve=>release=()=>resolve({logo:'https://www.iconaves.com/test.png'}));
 const work=market.lookupLogo(token,'bsc:'+token.address,{});market.stop();repo.close();release();await work;
});

test('stopping a running acquisition aborts immediately and survives database closure',async()=>{
 const {repo}=seeded();let aborted=false,entered;const ready=new Promise(resolve=>entered=resolve);
 const worker=new Worker(repo,{capture:ctx=>{entered();return new Promise((_,reject)=>ctx.signal.addEventListener('abort',()=>{aborted=true;reject(ctx.signal.reason);}));}});
 const work=worker.execute(worker.claim('capture'));await ready;worker.stop();repo.close();await work;
 assert.equal(aborted,true);assert.equal(worker.controllers.size,0);
});

test('a nonresponding statistics thread is terminated instead of leaving statistics locked forever',async()=>{
 const repo=new Repository(':memory:'),background=new BackgroundProjection(repo,{timeoutMs:20});let terminations=0;
 const thread={postMessage(){},terminate:async()=>{terminations++;}};background.worker=thread;repo.projectDirty=true;
 try{background.rebuild();await delay(50);assert.equal(terminations,1);assert.equal(background.flight,null);assert.equal(background.failures,1);assert.equal(repo.projectDirty,true);assert.ok(background.timer);}
 finally{await background.stop();repo.close();}
});

test('a burst of 200 calls, edits and withdrawals replays completely while the local delta API stays available',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xray-burst-')),repo=new Repository(path.join(dir,'test.sqlite')),ingestion=new IngestionService(repo);
 const market=new MarketService(repo,{}, {},ingestion),collectors=new Collectors(repo,ingestion);collectors.delivery.spoolFile=undefined;
 collectors.windows.configure({wechat:[],telegram:[{peerId:'123'}]});
 let fail=true;const ingest=ingestion.ingest.bind(ingestion);ingestion.ingest=m=>{if(fail)throw Error('simulated transient storage failure');return ingest(m);};
 repo.projectNow();repo.enableBackgroundProjection();const {server}=createServer({repo,ingestion,market,statistics:{},collectors,bridge:{},port:0});
 await once(server,'listening');const port=server.address().port,expected=new Set();let requests=0;
 const read=()=>new Promise((resolve,reject)=>{get(`http://127.0.0.1:${port}/api/token-updates?since=0`,{headers:{Host:'127.0.0.1:0'}},response=>{
   let body='';response.setEncoding('utf8');response.on('data',chunk=>body+=chunk);response.on('error',reject);response.on('end',()=>{try{assert.equal(response.statusCode,200);JSON.parse(body);requests++;resolve();}catch(error){reject(error);}});
 }).on('error',reject);});
 try{
  for(let i=1;i<=200;i++){
   const message={group:'tg:123',sourceId:'tg:123:'+i,time:now()-100,sender:'audit',senderId:'caller',chainHint:'bsc',addrs:[ca(i)],_deliveryLive:false};
   collectors.delivery.receive(message);expected.add(ca(i));
   if(i%5===0){collectors.delivery.receive({...message,messageEvent:'edit',messageRevision:Date.now(),addrs:[ca(i+10000)]});expected.delete(ca(i));expected.add(ca(i+10000));}
   if(i%7===0){collectors.delivery.receive({...message,messageEvent:'delete',messageRevision:Date.now()+1,addrs:[]});expected.delete(ca(i));expected.delete(ca(i+10000));}
   if(i%20===0)await read();
  }
  fail=false;repo.run('UPDATE delivery_inbox SET due=0');let turns=0;
  while(collectors.delivery.status().inbox){assert.ok(turns++<100);collectors.delivery.drainInbox();if(turns%5===0)await read();else await new Promise(setImmediate);}
  repo.run('UPDATE tokens SET verified=1');repo.project();
  assert.deepEqual(new Set(repo.view().map(t=>t.address)),expected);assert.equal(repo.get('SELECT COUNT(*) n FROM messages WHERE active=1').n,expected.size);assert.equal(collectors.delivery.status().outbox,0);
  const until=Date.now()+7000;while(repo.projectDirty&&Date.now()<until){await read();await delay(20);}
  assert.equal(repo.projectDirty,false);assert.deepEqual(new Set(repo.projection('rows',[]).map(t=>t.address)),expected);assert.ok(requests>=10);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));market.stop();await repo.backgroundProjection?.stop();repo.close();fs.rmSync(dir,{recursive:true});}
});
