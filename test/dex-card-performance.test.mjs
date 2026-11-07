import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {Dex} from '../src/adapters/core/dex.ts';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {DashboardContract} from '../src/services/dashboard-contract.mjs';
import {now} from '../src/domain/rules.mjs';
const ca=i=>'0x'+i.toString(16).padStart(40,'0');

test('first DEX metadata response feeds quotes across endpoints with original timestamps, exact identity and bounded freshness',async()=>{
 const original=https.request,clock=Date.now;let ms=clock()-20000,payload,requests=[];
 const pair=(address,chain='bsc',price='1')=>({chainId:chain,pairAddress:'pool-'+address,baseToken:{address,symbol:'AUDIT',name:'Audit'},info:{imageUrl:'https://cdn.dexscreener.com/test.png'},priceUsd:price,marketCap:1000,fdv:2000,liquidity:{usd:100}});
 Date.now=()=>ms;
 https.request=(url,options,callback)=>{
  requests.push(String(url));const request=new EventEmitter();request.destroy=error=>{request.emit('error',error);request.emit('close');};
  request.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=200;response.headers={};response.destroy=error=>response.emit('error',error);callback(response);response.emit('data',Buffer.from(JSON.stringify(payload)));response.emit('end');request.emit('close');});return request;
 };
 try{
  payload={pairs:[pair(ca(5001))]};const metadata=await Dex.lookupMetadata(ca(5001),'new-call');assert.equal(metadata.symbol,'AUDIT');const timestamp=Math.floor(ms/1000);
  ms+=500;const first=await Dex.batch('bsc',[ca(5001)]);assert.equal(requests.length,1);assert.equal(first.get(ca(5001)).price,1);assert.equal(first.get(ca(5001)).receivedAt,timestamp);
  first.get(ca(5001)).price=999;assert.equal((await Dex.lookup(ca(5001),'live','bsc')).price,1,'consumers cannot mutate the cached quote');
  assert.equal((await Dex.batchMetadata('bsc',[ca(5001)])).get(ca(5001)).symbol,'AUDIT');assert.equal(requests.length,1);
  ms+=1000;payload=[pair(ca(5002))];const mixed=await Dex.batch('bsc',[ca(5001),ca(5002)]);assert.equal(mixed.size,2);assert.equal(requests.length,2);assert.ok(!requests.at(-1).includes(ca(5001)));
  ms+=1000;payload=[pair(ca(5001),'ethereum','2')];const eth=await Dex.batch('ethereum',[ca(5001)]);assert.equal(eth.get(ca(5001)).price,2);assert.equal((await Dex.batch('bsc',[ca(5001)])).get(ca(5001)).price,1);
  ms+=1000;const sol='So11111111111111111111111111111111111111112';payload={pairs:[pair(sol,'solana','6')]};await Dex.lookupMetadata(sol);
  assert.equal((await Dex.batch('solana',[sol])).get(sol).price,6);
  ms+=1000;payload=[pair(sol,'solana','7')];assert.equal((await Dex.batch('solana',[sol.replace('So','so')])).size,0,'Solana address case cannot cross-hit');
  ms+=1000;payload=[pair(ca(5003),'ethereum','9')];assert.equal((await Dex.batch('bsc',[ca(5003)])).size,0,'foreign-chain response cannot seed a quote');
  ms+=4000;payload=[pair(ca(5001),'bsc','12')];const count=requests.length,refreshed=await Dex.batch('bsc',[ca(5001)]);assert.equal(requests.length,count+1);assert.equal(refreshed.get(ca(5001)).price,12);assert.equal(refreshed.get(ca(5001)).receivedAt,Math.floor(ms/1000));
 }finally{https.request=original;Date.now=clock;}
});

function fixture(count=3){
 const repo=new Repository(':memory:'),ingestion=new IngestionService(repo),live=new Map();
 for(let i=1;i<=count;i++)ingestion.ingest({group:'tg:123',sourceId:'m'+i,time:now()-100,chainHint:'bsc',addrs:[ca(i)],sender:'audit',senderId:'caller'});
 repo.run('UPDATE tokens SET verified=1');const market={liveQuote:(chain,address)=>live.get(chain+':'+address)};
 return {repo,ingestion,live,dashboard:new DashboardContract(repo,{},market,{},()=>{})};
}
test('unchanged cards are reused and a one-token quote or baseline change rebuilds only that card',()=>{
 const {repo,dashboard,live}=fixture();try{
 const first=dashboard.tokens(),byAddress=items=>new Map(items.map(t=>[t.address,t]));const before=byAddress(first);
 const initial=repo.performanceSnapshot().timings.token_dto_rebuild.count;const second=dashboard.tokens();assert.ok(second.every(t=>before.get(t.address)===t));assert.equal(repo.performanceSnapshot().timings.token_dto_rebuild.count,initial);
 const claim=repo.claim('bsc',ca(1));live.set('bsc:'+ca(1),{version:claim.version,provider:'dex',receivedAt:now(),quote:{price:2,mc:2000}});
 const changed=byAddress(dashboard.tokens());assert.notEqual(changed.get(ca(1)),before.get(ca(1)));assert.equal(changed.get(ca(2)),before.get(ca(2)));assert.equal(changed.get(ca(1)).market.price,2);assert.equal(repo.performanceSnapshot().timings.token_dto_rebuild.count,initial+1);
 repo.run('INSERT INTO price_results(chain,address,claim_version,baseline,updated_at) VALUES(?,?,?,?,?)','bsc',ca(1),claim.version,JSON.stringify({provider:'dex',price:1,at:claim.at}),now());
 const baseline=byAddress(dashboard.tokens());assert.equal(baseline.get(ca(1)).change,100);assert.equal(baseline.get(ca(2)),before.get(ca(2)));assert.equal(repo.performanceSnapshot().timings.token_dto_rebuild.count,initial+2);
 }finally{repo.close();}
});
test('a new shout changes only its own mentions; withdrawal, mute and exclusion invalidate correctly',()=>{
 const {repo,ingestion,dashboard}=fixture();try{
 let previous=new Map(dashboard.tokens().map(t=>[t.address,t]));
 ingestion.ingest({group:'tg:123',sourceId:'repeat',time:now(),chainHint:'bsc',addrs:[ca(1)],sender:'second'});
 let current=new Map(dashboard.tokens().map(t=>[t.address,t]));assert.equal(current.get(ca(1)).mentions.length,2);assert.notEqual(current.get(ca(1)),previous.get(ca(1)));assert.equal(current.get(ca(2)),previous.get(ca(2)));
 repo.set('statsExclusions',['bsc:'+ca(2)]);previous=current;current=new Map(dashboard.tokens().map(t=>[t.address,t]));assert.equal(current.get(ca(2)).statsExcluded,true);assert.equal(current.get(ca(1)),previous.get(ca(1)));
 repo.set('monitorMutes',['bsc:'+ca(2)]);assert.ok(!dashboard.tokens().some(t=>t.address===ca(2)));repo.set('monitorMutes',[]);assert.ok(dashboard.tokens().some(t=>t.address===ca(2)));
 ingestion.ingest({group:'tg:123',sourceId:'m3',time:now(),messageEvent:'delete',messageRevision:Date.now(),addrs:[],sender:'audit'});assert.ok(!dashboard.tokens().some(t=>t.address===ca(3)));assert.ok(!dashboard.tokenDtoCache.has('bsc:'+ca(3)));
 }finally{repo.close();}
});
test('time-based freshness and the rolling 24-hour window expire cached cards without a database write',()=>{
 const {repo,dashboard,live}=fixture(1),clock=Date.now;const start=clock();
 try{Date.now=()=>start;const claim=repo.claim('bsc',ca(1));live.set('bsc:'+ca(1),{version:claim.version,provider:'dex',receivedAt:now(),quote:{price:2}});
 const first=dashboard.tokens()[0];assert.equal(first.live,true);Date.now=()=>start+31000;const stale=dashboard.tokens()[0];assert.equal(stale.live,false);assert.notEqual(stale,first);
 Date.now=()=>start+86401000;assert.equal(dashboard.tokens().length,0);assert.equal(dashboard.tokenDtoCache.size,0);assert.equal(repo.liveRowCache.size,0);
 }finally{Date.now=clock;repo.close();}
});
test('a 200-card quote update decodes and rebuilds just one card',()=>{
 const {repo,dashboard,live}=fixture(200);try{
 const old=new Map(dashboard.tokens().map(t=>[t.address,t])),before=repo.performanceSnapshot();const claim=repo.claim('bsc',ca(100));
 live.set('bsc:'+ca(100),{version:claim.version,provider:'dex',receivedAt:now(),quote:{price:3,mc:3000}});
 const next=dashboard.tokens();assert.equal(next.filter(t=>old.get(t.address)!==t).length,1);
 const after=repo.performanceSnapshot();assert.equal(after.timings.token_dto_rebuild.count-before.timings.token_dto_rebuild.count,1);assert.equal(after.timings.live_row_decode.count,before.timings.live_row_decode.count);
 }finally{repo.close();}
});
