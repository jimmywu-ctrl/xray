import test from 'node:test';
import assert from 'node:assert/strict';
import {TelegramMonitor} from '../src/adapters/telegram/monitor.ts';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {Collectors} from '../src/services/collectors.mjs';
import {now} from '../src/domain/rules.mjs';
const a='0x'+'1'.repeat(40),b='0x'+'2'.repeat(40);
const message=(text,id=9)=>({id,chat:{id:123,type:'chat',chatType:'group',isGroup:true},date:new Date(Date.now()-30000),editDate:new Date(),sender:{id:7,type:'user',displayName:'test',username:'test'},text});
const initial={group:'tg:123',sourceId:'tg:123:9',time:now()-30,sender:'test',senderId:'7',chainHint:'bsc',addrs:[a]};

test('persisted TG edits still update or clear calls after restart and sender exclusion; unseen edits remain filtered',async()=>{
 const repo=new Repository(':memory:'),ingest=new IngestionService(repo);
 try{
  ingest.ingest(initial);
  const c=new Collectors(repo,ingest);c.windows.configure({wechat:[],telegram:[{peerId:'123'}]});
  const m=c.telegram;m.groups=new Map([['123',{peerId:'123'}]]);m.filters={'tg:123':{includeSenderIds:[],blockedSenderIds:['7']}};
  assert.equal(m.revisions.size,0);
  assert.equal(await m.receive(message(b),false,true),true);
  assert.equal(repo.get('SELECT active FROM mentions WHERE address=?',a).active,0);
  assert.equal(repo.get('SELECT active FROM mentions WHERE address=?',b).active,1);
  assert.equal(await m.receive(message(a,10),false,true),false);
  assert.equal(repo.get('SELECT COUNT(*) n FROM messages').n,1);
  const removed=message('CA removed');removed.editDate=new Date(Date.now()+2);
  assert.equal(await m.receive(removed,false,true),true);
  assert.equal(repo.get('SELECT active FROM mentions WHERE address=?',b).active,0);
 }finally{repo.close();}
});

test('a known edit cannot regress its revision, and filtering still blocks new messages',async()=>{
 const delivered=[],m=new TelegramMonitor(e=>delivered.push(e));m.groups=new Map([['123',{peerId:'123'}]]);
 m.filters={'tg:123':{includeSenderIds:['other'],blockedSenderIds:[]}};
 m.knownMessageRevision=()=>Date.now()+10000;
 assert.equal(await m.receive(message(b),false,true),false);
 m.knownMessageRevision=()=>null;const fresh=message(a);delete fresh.editDate;
 assert.equal(await m.receive(fresh,false),false);assert.equal(delivered.length,0);
});

test('edits prefetch only added CA keys and reuse the existing urgent update path',()=>{
 const repo=new Repository(':memory:'),changes=[],ingest=new IngestionService(repo,o=>changes.push(o));
 try{
  ingest.ingest(initial);assert.deepEqual(changes.at(-1).prefetchKeys,['bsc:'+a]);
  ingest.ingest({...initial,messageEvent:'edit',messageRevision:Date.now(),addrs:[a,b]});
  assert.deepEqual(changes.at(-1).prefetchKeys,['bsc:'+b]);assert.equal(changes.at(-1).urgent,true);
  ingest.ingest({...initial,messageEvent:'edit',messageRevision:Date.now()+2,addrs:[a,b]});
  assert.deepEqual(changes.at(-1).prefetchKeys,[]);
  ingest.ingest({...initial,messageEvent:'edit',messageRevision:Date.now()+3,addrs:[b]});
  assert.deepEqual(changes.at(-1).prefetchKeys,[]);
 }finally{repo.close();}
});

test('history and bots do not consume immediate metadata prefetch slots',()=>{
 for(const extra of [{backfill:true},{isBot:true}]){
  const repo=new Repository(':memory:'),changes=[],ingest=new IngestionService(repo,o=>changes.push(o));
  try{ingest.ingest({...initial,...extra});ingest.ingest({...initial,...extra,messageEvent:'edit',messageRevision:Date.now(),addrs:[b]});assert.equal(changes.at(-1)?.prefetchKeys?.length??0,0);}
  finally{repo.close();}
 }
});
