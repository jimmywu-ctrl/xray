import test from 'node:test';
import assert from 'node:assert/strict';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {MarketService} from '../src/services/market.mjs';
import {acquisitionStatus} from '../src/services/acquisition-status.mjs';
import {choosePair,restorePairSelection} from '../src/adapters/core/dex.ts';
import {now} from '../src/domain/rules.mjs';
const address='0x'+'4'.repeat(40);
function fixture(){
 const repo=new Repository(':memory:'),ingestion=new IngestionService(repo),at=now()-300;
 const msg={source:'telegram',channel:'tg:five',chain:'bsc',addresses:[address],sender:'A'};
 ingestion.ingest({...msg,message:'first',at});repo.run('UPDATE tokens SET verified=1');
 const token=repo.claim('bsc',address);
 repo.run('INSERT INTO price_results(chain,address,claim_version,baseline,updated_at) VALUES(?,?,?,?,?)','bsc',address,token.version,JSON.stringify({provider:'ave',price:1,value:1,at}),now());
 return {repo,ingestion,msg,token};
}
test('new shouts and revised ownership do not bypass a live provider cooldown',()=>{
 const {repo,ingestion,msg,token}=fixture();try{
  const m=new MarketService(repo,{}, {},ingestion),key='bsc:'+address;
  for(let i=0;i<3;i++)m.noteLiveProviderFailure(token,'dex','未返回有效价格');
  const until=m.liveProviderFailures.get(key+'|dex').retryAt;
  ingestion.ingest({...msg,message:'again',at:now()});
  assert.equal(m.liveProviderFailureCount(key,'dex',{...token,lastCall:now(),version:token.version+1}),3);
  assert.equal(m.liveProviderFailures.get(key+'|dex').retryAt,until);
 }finally{repo.close();}
});
test('repeat shouts preserve durable backoff and exhausted retry budgets',()=>{
 const {repo,ingestion,msg}=fixture();try{
  const due=now()+3600;repo.run("UPDATE jobs SET state='BACKOFF',due=?,attempts=2,payload=?",due,JSON.stringify({stage:'history',failureAttempts:2}));
  ingestion.ingest({...msg,message:'backoff-repeat',at:now()-1});
  let row=repo.get('SELECT * FROM jobs');assert.equal(row.state,'BACKOFF');assert.equal(row.due,due);assert.equal(row.attempts,2);
  repo.run("UPDATE jobs SET state='PARKED',wait='limit'");ingestion.ingest({...msg,message:'parked-repeat',at:now()});
  row=repo.get('SELECT * FROM jobs');assert.equal(row.state,'PARKED');assert.equal(row.wait,'limit');
 }finally{repo.close();}
});
test('a fresh shout after manual stop creates automatic work without restarting its stopped batch',()=>{
 const {repo,ingestion,msg}=fixture();try{
  repo.run("UPDATE jobs SET state='PARKED',wait='manual_stop',payload=?",JSON.stringify({stage:'history',manual:true,manualBatchId:'stopped-batch',manualAttempts:2}));
  repo.set('manualRepairBatchV1',{id:'stopped-batch',status:'stopped',total:1});
  ingestion.ingest({...msg,message:'after-stop',at:now()});
  const row=repo.get('SELECT * FROM jobs'),p=JSON.parse(row.payload),report=repo.setting('manualRepairBatchV1');
  assert.equal(row.state,'QUEUED');assert.equal(p.manualBatchId,undefined);assert.equal(p.manual,undefined);assert.equal(p.refresh,true);
  assert.equal(report.status,'stopped');assert.equal(report.rows[0].wait,'manual_stop');assert.equal(repo.get('SELECT count(*) n FROM jobs').n,1);
 }finally{repo.close();}
});
test('no-data notices stop promising retries after the finite recheck budget is exhausted',()=>{
 assert.match(acquisitionStatus({state:'PARKED',wait:'nodata',payload:{automaticRechecks:3}}).label,/等待低频复查/);
 assert.match(acquisitionStatus({state:'PARKED',wait:'nodata',payload:{automaticRechecks:4}}).label,/已达上限/);
 assert.doesNotMatch(acquisitionStatus({state:'PARKED',wait:'nodata',payload:{automaticRechecks:4}}).label,/等待/);
});
test('more than ten visible cards are all prioritized in one batched chain request',()=>{
 const m=new MarketService({diagnostic(){},setting(k,f){return k==='logoLookupStrategyVersion'?11:f;}},{},{},{}),requests=[];
 m.refreshFastMetadata=async()=>{};m.refreshDexBatch=(chain,items)=>requests.push({chain,items});
 const keys=Array.from({length:18},(_,i)=>'bsc:0x'+String(i+1).padStart(40,'0'));
 m.inventory=new Map(keys.map(key=>[key,{chain:'bsc',address:key.slice(4),version:1,lastCall:now()}]));
 try{m.setVisible(keys);assert.equal(m.visible.size,18);assert.equal(requests.length,1);assert.equal(requests[0].items.length,18);}
 finally{m.stop();}
});
function pair(id,liq,price='1',chainId='bsc'){return {chainId,pairAddress:id,baseToken:{address},priceUsd:price,liquidity:{usd:liq}};}
test('main pool ignores small fluctuations and requires sustained 50 percent improvement',()=>{
 const state=new Map();assert.equal(choosePair([pair('A',100),pair('B',90)],state,0).pairAddress,'A');
 assert.equal(choosePair([pair('A',100),pair('B',110)],state,1000).pairAddress,'A');
 assert.equal(choosePair([pair('A',100),pair('B',160)],state,10000).pairAddress,'A');
 assert.equal(choosePair([pair('A',100),pair('B',160)],state,40000).pairAddress,'A');
 assert.equal(choosePair([pair('A',100),pair('B',160)],state,61000).pairAddress,'B');
});
test('missing, invalid or dry main pools fail over immediately and chains stay isolated',()=>{
 for(const replacement of [[],[pair('A',100,'0')],[pair('A',0)]]){
  const state=new Map();choosePair([pair('A',100)],state,0);
  assert.equal(choosePair([...replacement,pair('B',90)],state,1000).pairAddress,'B');
 }
 const state=new Map();choosePair([pair('A',100)],state,0);
 assert.equal(choosePair([pair('C',200,'1','ethereum')],state,1).pairAddress,'C');assert.equal(state.size,2);
});

test('restart restores the last known DEX pool without flipping to a marginally larger pool',()=>{
 const state=new Map();restorePairSelection('bsc',address,'A',state,0);
 assert.equal(choosePair([pair('A',100),pair('B',110)],state,1000).pairAddress,'A');
 restorePairSelection('bsc',address,'B',state,2000);
 assert.equal(choosePair([pair('A',100),pair('B',110)],state,3000).pairAddress,'A');
});
