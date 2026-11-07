import test from 'node:test';
import assert from 'node:assert/strict';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {MarketService,mergeLiveQuote,primaryDexQuote} from '../src/services/market.mjs';
import {DashboardContract} from '../src/services/dashboard-contract.mjs';
import {resumeAutomaticAfterManual} from '../src/services/manual-repair-resume.mjs';
import {plausibleMarketCap,sanitizeMarketQuote} from '../src/adapters/core/quote-contract.ts';
import {now,CAPTURE_REFRESH_INTERVAL_SEC} from '../src/domain/rules.mjs';
const address='0x'+'6'.repeat(40);
function fixture(){
 const repo=new Repository(':memory:'),ingestion=new IngestionService(repo),at=now()-7200;
 ingestion.ingest({source:'telegram',channel:'tg:test',message:'one',at,chain:'bsc',addresses:[address],sender:'A'});
 repo.run('UPDATE tokens SET verified=1');const claim=repo.claim('bsc',address);
 repo.run('INSERT INTO price_results(chain,address,claim_version,baseline,peak,updated_at) VALUES(?,?,?,?,?,?)','bsc',address,claim.version,JSON.stringify({provider:'ave',price:1,value:1,at}),JSON.stringify({provider:'ave',multiple:3,coverage:{to:now()-60}}),now());
 const market=new MarketService(repo,{}, {},ingestion);return {repo,ingestion,market};
}
test('known chain hints do not turn unverified addresses into confirmed token counts',()=>{
 const {repo,ingestion,market}=fixture();try{
  for(const [i,chain] of ['eth','?'].entries())ingestion.ingest({source:'telegram',channel:'tg:test',message:'candidate'+i,at:now()-60,chain,addresses:['0x'+String(i+7).repeat(40)],sender:'A'});
  const rows=new DashboardContract(repo,{},market,{},()=>{}).tokens();
  assert.equal(rows.length,3);assert.equal(rows.filter(t=>t.verified===true).length,1);
  assert.equal(rows.filter(t=>t.pending&&t.verified===false).length,2);
 }finally{repo.close();}
});
test('implausible same-source market caps are removed without replacing FDV or price',()=>{
 assert.equal(plausibleMarketCap(1917118,770166),false);assert.equal(plausibleMarketCap(100,100),true);assert.equal(plausibleMarketCap(104,100),true);
 const q=sanitizeMarketQuote({provider:'dex',price:0.003036,mc:1917118,fdv:770166});assert.equal(q.mc,undefined);assert.equal(q.price,0.003036);assert.equal(q.fdv,770166);
 assert.equal(plausibleMarketCap(Infinity),false);assert.equal(plausibleMarketCap(-1),false);
});
test('AVE fills the rejected DEX market cap while DEX keeps its valid price',()=>{
 const dex={provider:'dex',receivedAt:now(),price:0.003036,mc:1917118,fdv:770166};
 const ave={provider:'ave',receivedAt:now(),price:0.0030357,mc:769149,fdv:770000};
 const q=mergeLiveQuote(primaryDexQuote(dex),ave,{quote:dex});
 assert.equal(q.price,dex.price);assert.equal(q.mc,ave.mc);assert.equal(q.fieldSources.mc.provider,'ave');assert.equal(q.fieldSources.price.provider,'dex');
 const mixed=sanitizeMarketQuote({mc:120,fdv:100,fieldSources:{mc:{provider:'ave'},fdv:{provider:'dex'}}});assert.equal(mixed.mc,120);
});
test('cached invalid DEX market caps cannot flash back after restart',()=>{
 const {repo}=fixture();try{
  repo.run('INSERT INTO quotes(chain,address,provider,payload,received_at,generation) VALUES(?,?,?,?,?,1)','bsc',address,'dex',JSON.stringify({price:1,mc:200,fdv:100}),now());
  assert.equal(repo.view()[0].quote.mc,undefined);assert.equal(repo.view()[0].quote.price,1);
 }finally{repo.close();}
});
test('manual completion freezes its report then resumes the same automatic job within fifteen minutes',()=>{
 const {repo,market}=fixture();try{
  repo.run("UPDATE jobs SET state='DONE',payload=?",JSON.stringify({stage:'history',manual:true,manualBatchId:'batch',manualAttempts:2,historyCursor:now()-60}));
  repo.set('manualRepairBatchV1',{id:'batch',status:'running',total:1});
  assert.equal(resumeAutomaticAfterManual(repo),1);
  const row=repo.get('SELECT * FROM jobs'),payload=JSON.parse(row.payload);
  assert.equal(row.state,'QUEUED');assert.ok(row.due<=now()+CAPTURE_REFRESH_INTERVAL_SEC);assert.equal(payload.manualBatchId,undefined);assert.equal(payload.manual,undefined);assert.equal(payload.refresh,true);assert.ok(payload.historyCursor);
  assert.equal(repo.setting('manualRepairBatchV1').status,'complete');assert.equal(repo.setting('manualRepairBatchV1').rows[0].state,'DONE');
  repo.run('UPDATE price_results SET peak=?',JSON.stringify({multiple:9}));
  const d=new DashboardContract(repo,{},market,{},()=>{});assert.equal(JSON.parse(d.manualRepairRows('batch')[0].peak).multiple,3);
  assert.equal(repo.get('SELECT count(*) n FROM jobs').n,1);assert.equal(resumeAutomaticAfterManual(repo),0);
 }finally{repo.close();}
});
test('unfinished manual batches keep their membership, and explicit stops stay stopped',()=>{
 const {repo}=fixture();try{
  repo.run("UPDATE jobs SET state='BACKOFF',payload=?",JSON.stringify({stage:'history',manual:true,manualBatchId:'batch'}));repo.set('manualRepairBatchV1',{id:'batch',status:'running',total:1});
  assert.equal(resumeAutomaticAfterManual(repo),0);assert.equal(JSON.parse(repo.get('SELECT payload FROM jobs').payload).manualBatchId,'batch');
  repo.run("UPDATE jobs SET state='PARKED',wait='manual_stop'");repo.set('manualRepairBatchV1',{id:'batch',status:'stopped',total:1});
  resumeAutomaticAfterManual(repo);assert.equal(repo.get('SELECT state FROM jobs').state,'PARKED');assert.equal(repo.get('SELECT wait FROM jobs').wait,'manual_stop');
 }finally{repo.close();}
});
