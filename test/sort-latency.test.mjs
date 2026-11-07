import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { once } from 'node:events';
import { request } from 'node:http';
import { Repository } from '../src/infra/database.mjs';
import { createServer } from '../src/server.mjs';

test('sort defaults off and preserves all supported saved preferences including legacy off',()=>{
 const source=fs.readFileSync(new URL('../src/ui/overlay.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('function savedPeakMultipleSort()'),source.indexOf('  var state ='));
 for(const [prefs,expected] of [[{},'off'],[{'fomomo.peakMultipleSort':'off'},'off'],[{'fomomo.callMultipleSort':'asc'},'asc'],[{'fomomo.peakMultipleSort.v3':'desc'},'desc'],[{'fomomo.peakMultipleSort.v3':'off','fomomo.peakMultipleSort':'desc'},'off'],[{'fomomo.peakMultipleSort':'invalid'},'off']]){
  assert.equal(vm.runInNewContext(fn+';savedPeakMultipleSort()',{localStorage:{getItem:key=>prefs[key]??null}}),expected);
 }
 assert.equal(vm.runInNewContext(fn+';savedPeakMultipleSort()',{localStorage:{getItem(){throw Error('blocked');}}}),'off');
});

test('receipt keeps first client time across retries, visible receipt order, and rejects invalid time',async()=>{
 const repo=new Repository(':memory:');let web;
 try{
  const at=Date.now()-120000,traceId='receipt-audit';
  repo.diagnostic('message_latency',traceId,JSON.stringify({detectedAtMs:at-10,ingestedAtMs:at,displayedAtMs:null}));
  web=createServer({repo,ingestion:{},statistics:{},market:{liveQuote:()=>null},collectors:{},bridge:{},port:0});
  if(!web.server.listening)await once(web.server,'listening');
  const post=(path,body)=>new Promise((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',port:web.server.address().port,path:'/api/debug/message-latency/'+path,method:'POST',headers:{host:'127.0.0.1:0','Content-Type':'application/json'}},res=>{
    let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>{try{assert.equal(res.statusCode,200);resolve(JSON.parse(data));}catch(error){reject(error);}});
   });req.on('error',reject);req.end(JSON.stringify(body));
  });
  const read=()=>JSON.parse(repo.get("SELECT detail FROM diagnostics WHERE category='message_latency' AND token=?",traceId).detail);
  assert.equal((await post('received',{entries:[{traceId,receivedAtMs:at-1}]})).updated,0);
  assert.equal((await post('received',{entries:[{traceId,receivedAtMs:at+20}]})).updated,1);
  assert.equal((await post('received',{entries:[{traceId,receivedAtMs:Date.now()}]})).updated,0);
  assert.equal(read().ingestToReceivedMs,20);
  const displayedAtMs=Date.now();await post('rendered',{traceIds:[traceId],displayedAtMs});
  assert.equal(read().receivedToDisplayMs,displayedAtMs-at-20);
  repo.run("UPDATE diagnostics SET detail=? WHERE token=?",JSON.stringify({detectedAtMs:at,ingestedAtMs:at,displayedAtMs}),traceId);
  await post('received',{entries:[{traceId,receivedAtMs:at+30}]});
  assert.equal(read().receivedToDisplayMs,displayedAtMs-at-30);
 }finally{if(web){web.server.closeAllConnections();await new Promise(resolve=>web.server.close(resolve));}repo.close();}
});

test('projection exposes bounded phase metrics, process ID and event loop delay',()=>{
 const repo=new Repository(':memory:');try{
  repo.projectNow();const snapshot=repo.performanceSnapshot();
  assert.equal(snapshot.pid,process.pid);
  for(const key of ['project_query','project_parse','project_rank','project_overview','project_cache'])assert.equal(snapshot.timings[key].count,1);
  assert.ok(snapshot.eventLoopDelay.maxMs>=0);
  assert.ok(repo.get("SELECT 1 FROM sqlite_master WHERE name='diagnostics_trace'"));
 }finally{repo.close();}
});
