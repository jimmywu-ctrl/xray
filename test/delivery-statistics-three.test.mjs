import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {Collectors} from '../src/services/collectors.mjs';
import {ReliableDelivery} from '../src/services/reliable-delivery.mjs';
import {BackgroundProjection} from '../src/infra/background-projection.mjs';
import {WechatWatcher} from '../src/adapters/wechat/watch.ts';
import {wechatMessageSourceId} from '../src/adapters/wechat/reader.ts';
import {displayText,extractAddresses} from '../src/adapters/wechat/extract.ts';
import {now} from '../src/domain/rules.mjs';
const a='0x'+'1'.repeat(40),b='0x'+'2'.repeat(40);
const msg=(peer='123')=>({group:'tg:'+peer,sourceId:`tg:${peer}:9`,time:now(),sender:'audit',senderId:'9',text:a,addrs:[a],_deliveryLive:false});
const waitFor=async(predicate,ms=7000)=>{const until=Date.now()+ms;while(!predicate()){if(Date.now()>until)throw Error('condition timed out');await new Promise(r=>setTimeout(r,20));}};

test('ordinary-group deletion queued before the first successful insert survives restart and cancels the call',()=>{
 const repo=new Repository(':memory:'),ingestion=new IngestionService(repo),c=new Collectors(repo,ingestion);
 try{c.delivery.spoolFile=undefined;c.windows.configure({wechat:[],telegram:[{peerId:'123'}]});c.telegram.groups=new Map([['123',{peerId:'123'}]]);
 let fail=true;const ingest=ingestion.ingest.bind(ingestion);ingestion.ingest=m=>{if(fail)throw Error('temporary insert failure');return ingest(m);};
 const original={...msg(),time:now()+2};c.delivery.receive(original);assert.equal(c.delivery.status().inbox,1);
 c.telegram.receiveDeletion(null,[9]);assert.equal(c.delivery.status().inbox,2);
 // Recreate the delivery processor to simulate retry after restart without the monitor's receive cache.
 const replay=new ReliableDelivery(repo,c.delivery.processMessage,async()=>{});fail=false;repo.run('UPDATE delivery_inbox SET due=0');replay.drainInbox();replay.drainInbox();
 assert.equal(repo.get('SELECT active FROM messages').active,0);assert.ok(repo.get('SELECT revision FROM messages').revision>original.time*1000);assert.equal(repo.get('SELECT active FROM claims').active,0);assert.equal(replay.status().inbox,0);
 }finally{repo.close();}
});

test('fallback-file originals are considered during delete routing, and ambiguous peers remain untouched',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xray-delete-')),repo=new Repository(':memory:');
 try{const file=path.join(dir,'spool.jsonl'),d=new ReliableDelivery(repo,()=>{},async()=>{},file);
 fs.writeFileSync(file,JSON.stringify({payload:JSON.stringify(msg())})+'\n');assert.deepEqual(d.telegramDeletePeers(9),['123']);
 d.processMessage=()=>{throw Error('pending');};d.receive(msg('456'));assert.deepEqual(new Set(d.telegramDeletePeers(9)),new Set(['123','456']));
 }finally{repo.close();fs.rmSync(dir,{recursive:true});}
});

test('the receive cache routes a deletion while the database lookup is temporarily unavailable',()=>{
 const repo=new Repository(':memory:'),c=new Collectors(repo,new IngestionService(repo));
 try{c.telegram.groups=new Map([['123',{peerId:'123'}]]);c.telegram.context=new Map([['123',[{sourceId:'tg:123:9'}]]]);c.telegram.knownDeletePeers=()=>[];
 const delivered=[];c.telegram.onMsg=m=>delivered.push(m);c.telegram.receiveDeletion(null,[9]);assert.equal(delivered[0].group,'tg:123');assert.equal(delivered[0].messageEvent,'delete');assert.ok(delivered[0].messageRevision);
 c.telegram.context=new Map([['123',[{sourceId:'tg:123:9'}]],['456',[{sourceId:'tg:456:9'}]]]);c.telegram.groups.set('456',{peerId:'456'});c.telegram.receiveDeletion(null,[9]);assert.equal(delivered.length,1);
 }finally{repo.close();}
});

test('same-title offline link changes update the contract, while unchanged links do not fabricate an edit',()=>{
 const repo=new Repository(':memory:'),at=now()-3600;
 repo.db.exec('CREATE TABLE sample(local_id INTEGER PRIMARY KEY,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT,WCDB_CT_message_content INTEGER)');
 const xml=address=>`<appmsg><title>same title</title><url>https://gmgn.ai/bsc/token/${address}</url><type>5</type></appmsg>`;
 try{repo.run('INSERT INTO sample VALUES(1,49,?,1,?,0)',at,xml(a));
 const seed={t:'msg',sourceId:wechatMessageSourceId(repo.db.name,1),time:at,sender:'audit',text:displayText(xml(a),49),...extractAddresses(xml(a),49),backfill:false};
 const make=()=>{const w=new WechatWatcher();w.ensureSender=()=>{};w.formatContent=text=>({sender:'audit',text});w.seedKnownCalls([seed]);return w;};
 const shard={db:repo.db,table:'sample',name2id:new Map()},events=[];
 make().reconcileTrackedCalls(shard,false,'audit',e=>events.push(e));assert.equal(events.length,0);
 repo.run('UPDATE sample SET message_content=?',xml(b));make().reconcileTrackedCalls(shard,false,'audit',e=>events.push(e));assert.deepEqual(events[0].addrs,[b]);assert.equal(events[0].messageEvent,'edit');
 }finally{repo.close();}
});

test('unchanged 300-character preview cannot hide an offline edit after the preview',()=>{
 const repo=new Repository(':memory:'),w=new WechatWatcher();
 try{repo.db.exec('CREATE TABLE sample(local_id INTEGER PRIMARY KEY,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content TEXT,WCDB_CT_message_content INTEGER)');const prefix='x '.repeat(180),at=now()-600;
 repo.run('INSERT INTO sample VALUES(1,1,?,1,?,0)',at,prefix+b);w.ensureSender=()=>{};w.formatContent=text=>({sender:'audit',text});
 w.seedKnownCalls([{t:'msg',sourceId:wechatMessageSourceId(repo.db.name,1),time:at,sender:'audit',text:(prefix+a).slice(0,300),addrs:[a],chainHint:null,backfill:false}]);const events=[];
 w.reconcileTrackedCalls({db:repo.db,table:'sample',name2id:new Map()},false,'audit',e=>events.push(e));assert.deepEqual(events[0].addrs,[b]);
 }finally{repo.close();}
});

test('file-backed live statistics calculate off-thread, match synchronous results, and recover after thread exit',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xray-statistics-')),repo=new Repository(path.join(dir,'test.sqlite')),ingestion=new IngestionService(repo);
 try{ingestion.ingest({...msg(),chainHint:'bsc'});repo.run('UPDATE tokens SET verified=1');repo.projectNow();const expected=structuredClone(repo.projection('rows',[]));
 repo.enableBackgroundProjection();const view=repo.view.bind(repo);repo.view=()=>{throw Error('main thread must not rebuild statistics');};let published=0;repo.onProjected=()=>published++;
 for(let i=0;i<100;i++)repo.project();await waitFor(()=>published===1);assert.deepEqual(repo.projection('rows',[]),expected);assert.ok(repo.performanceSnapshot().timings.project_background);assert.equal(repo.projectDirty,false);
 const previousThread=repo.backgroundProjection.worker;await previousThread.terminate();await waitFor(()=>published===2);assert.notEqual(repo.backgroundProjection.worker,previousThread);
 repo.view=view;repo.projectNow();assert.deepEqual(repo.projection('rows',[]),expected);
 }finally{await repo.backgroundProjection?.stop();repo.close();fs.rmSync(dir,{recursive:true});}
});

test('an older statistical result cannot overwrite a newer invalidation or an explicit synchronous snapshot',()=>{
 const repo=new Repository(':memory:'),p=new BackgroundProjection(repo),worker={};
 try{p.worker=worker;p.flight={id:1,version:1};p.version=2;repo.projectDirty=true;const original=repo.projectionCache;
 p.receive(worker,{id:1,elapsedMs:1,snapshot:{rows:[{stale:true}],overview:{total:1},leaderboard:[]}});assert.equal(repo.projection('rows',null),null);assert.equal(repo.projectDirty,true);assert.equal(repo.projectionCache,original);
 clearTimeout(p.timer);p.timer=null;p.flight={id:2,version:2};p.supersede();repo.projectDirty=false;p.receive(worker,{id:2,elapsedMs:1,snapshot:{rows:[{stale:true}],overview:{total:1},leaderboard:[]}});assert.equal(repo.projection('rows',null),null);assert.equal(repo.projectDirty,false);
 }finally{p.worker=null;p.stop();repo.close();}
});
