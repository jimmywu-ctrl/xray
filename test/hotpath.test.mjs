import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { Repository } from '../src/infra/database.mjs';
import { IngestionService } from '../src/services/ingestion.mjs';
import { DashboardContract } from '../src/services/dashboard-contract.mjs';
import { createServer } from '../src/server.mjs';
import { now } from '../src/domain/rules.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const address = id => '0x' + id.toString(16).padStart(40, '0');
function seed(repo, id, {chain='bsc', at=now()-86400, verified=1, multiple=2, version=1, priceVersion=version}={}) {
  const a=address(id),message=`seed-${chain}-${id}`;
  repo.run('INSERT INTO tokens(chain,address,verified,metadata,last_call) VALUES(?,?,?,?,?)',chain,a,verified,JSON.stringify({symbol:`T${id}`,name:`Token ${id}`}),at);
  repo.run('INSERT INTO mentions(source,channel,message,chain,address,sender_key,sender,at,bot,active) VALUES(?,?,?,?,?,?,?,?,0,1)','telegram','tg:1',message,chain,a,'telegram:caller','Caller',at);
  const owner=repo.get('SELECT id FROM mentions WHERE chain=? AND address=?',chain,a).id;
  repo.run('INSERT INTO claims(chain,address,owner,version,at,active) VALUES(?,?,?,?,?,1)',chain,a,owner,version,at);
  repo.run('INSERT INTO results(chain,address,claim_version,status) VALUES(?,?,?,?)',chain,a,version,'missing_baseline');
  repo.run('INSERT INTO price_results(chain,address,claim_version,baseline,peak,updated_at) VALUES(?,?,?,?,?,?)',chain,a,priceVersion,JSON.stringify({provider:'ave_api',price:1,mc:1000,at}),JSON.stringify({provider:'ave_api',price:multiple,mc:1000*multiple,multiple,at:at+1}),at);
  return a;
}
function contract(repo){return new DashboardContract(repo,{}, {liveQuote:()=>null},null,()=>{});}
function message(a,id,at=now()){return {source:'telegram',channel:'tg:1',message:id,at,addresses:[a],chain:'bsc',sender:'Caller',senderId:'caller',detectedAtMs:Date.now()};}

test('joined view keeps quote selection and rejects results from another claim version without N+1 queries',()=>{
  const repo=new Repository(':memory:');
  try{
    repo.transaction(()=>{for(let i=1;i<=100;i++)seed(repo,i,{priceVersion:i===1?2:1});});
    repo.set('quoteSource','dex');
    repo.set('quoteSources',{['bsc:'+address(2)]:'ave'});
    for(const provider of ['ave','dex'])repo.run('INSERT INTO quotes VALUES(?,?,?,?,?,?)','bsc',address(2),provider,JSON.stringify({provider,mc:1234,price:1}),now(),1);
    let reads=0;
    const get=repo.get.bind(repo);repo.get=(...args)=>{reads++;return get(...args);};
    const rows=repo.view();
    assert.equal(rows.length,100);
    assert.equal(reads,2,'only quote settings are read separately');
    assert.equal(rows.find(r=>r.address===address(1)).priceBaseline,null);
    assert.equal(rows.find(r=>r.address===address(2)).quote.provider,'ave');
    assert.equal(rows.find(r=>r.address===address(2)).priceMultiple,2);
  }finally{repo.close();}
});

test('single-address lookup is bounded, normalizes EVM case, and uses an address index',()=>{
  const repo=new Repository(':memory:');
  try{
    repo.transaction(()=>{for(let i=1;i<=100;i++)seed(repo,i);});
    const original=repo.view.bind(repo);let options;
    repo.view=o=>{options=o;return original(o);};
    assert.equal(repo.tokenByAddress(address(42).toUpperCase()).symbol,'T42');
    assert.equal(options.limit,1);
    assert.equal(options.address,address(42).toUpperCase());
    assert.equal(repo.tokenByAddress(address(101)),null);
    assert.ok(repo.all('EXPLAIN QUERY PLAN SELECT * FROM claims WHERE address=?',address(42)).some(r=>r.detail.includes('claims_address')));
  }finally{repo.close();}
});

test('projections remain in memory; repeated invalidations coalesce and a later update is not lost',async()=>{
  const repo=new Repository(':memory:');
  try{
    seed(repo,1);
    repo.projectNow();
    const rows=repo.projection('rows',[]);
    assert.equal(repo.projection('rows',[]),rows);
    assert.equal(repo.get('SELECT COUNT(*) n FROM projections').n,0);
    let notifications=0;repo.onProjected=()=>notifications++;
    for(let i=0;i<100;i++)repo.project();
    assert.equal(repo.performanceSnapshot().timings.project.count,1);
    assert.equal(repo.projection('rows',[]),rows,'no expensive rebuilding on a hot-path invalidation');
    await delay(300);
    assert.equal(notifications,1);
    assert.equal(repo.performanceSnapshot().timings.project.count,2);
    repo.project();
    await delay(300);
    assert.equal(notifications,2);
    assert.equal(repo.get('SELECT COUNT(*) n FROM projections').n,0);
  }finally{repo.close();}
});

test('new and repeat calls appear before statistics flush within the rolling 24-hour window',()=>{
  const repo=new Repository(':memory:');
  try{
    const seededAt=now()-2*86400;
    repo.transaction(()=>{for(let i=1;i<=1000;i++)seed(repo,i,{at:seededAt});});
    repo.projectNow();
    const dashboard=contract(repo),ingestion=new IngestionService(repo);
    assert.equal(dashboard.tokens().length,0);
    const a=address(1),ts=now();
    ingestion.ingest(message(a,'live-1',ts));
    let tokens=dashboard.tokens();
    assert.equal(tokens.length,1);
    assert.equal(tokens[0].firstSeen,ts);
    assert.ok(tokens[0].mentions.some(m=>m.traceId==='["telegram","tg:1","live-1"]'));
    assert.equal(repo.performanceSnapshot().timings.project.count,1,'new card did not trigger or wait for full statistics');
    assert.equal(repo.projection('rows',[])[0].lastCall,seededAt,'background snapshot is intentionally still unchanged');
    ingestion.ingest(message(a,'live-2',ts+1));
    tokens=dashboard.tokens();
    assert.equal(tokens[0].firstSeen,ts+1);
    assert.equal(tokens[0].mentions.length,3);
    assert.ok(repo.get("SELECT due FROM jobs WHERE lane='capture' AND address=?",a).due<=now()+900,JSON.stringify(repo.all("SELECT state,payload,due FROM jobs WHERE address=?",a)));
    assert.equal(repo.get('SELECT COUNT(*) n FROM messages').n,2,'raw messages still persist immediately');
  }finally{repo.close();}
});

test('unconfirmed new CA and its deletion are visible without a statistics flush',()=>{
  const repo=new Repository(':memory:');
  try{
    repo.projectNow();
    const ingestion=new IngestionService(repo),dashboard=contract(repo),e=message(address(1),'pending');
    ingestion.ingest(e);
    assert.equal(dashboard.tokens()[0].pending,true);
    ingestion.ingest({...e,kind:'delete',revision:e.at*1000+1});
    assert.deepEqual(dashboard.tokens(),[]);
    assert.equal(repo.performanceSnapshot().timings.project.count,1);
  }finally{repo.close();}
});

test('price-result updates reach cards immediately without querying message history again',()=>{
  const repo=new Repository(':memory:');
  try{
    const a=seed(repo,1,{at:now()-10});
    repo.projectNow();
    const dashboard=contract(repo);
    let mentionReads=0;
    const all=repo.all.bind(repo);repo.all=(sql,...args)=>{if(sql.startsWith('SELECT chain,address,source,sender,at,channel,message FROM mentions'))mentionReads++;return all(sql,...args);};
    assert.equal(dashboard.tokens()[0].confirmedPeakX,2);
    repo.run('UPDATE price_results SET peak=? WHERE address=?',JSON.stringify({provider:'ave_api',price:3,mc:3000,multiple:3,at:now()}),a);
    repo.project();
    assert.equal(dashboard.tokens()[0].confirmedPeakX,3);
    assert.equal(mentionReads,1);
  }finally{repo.close();}
});

test('startup rebuild ignores stale legacy disk projections and close cancels pending rebuilds',async()=>{
  const repo=new Repository(':memory:');
  seed(repo,1);
  repo.run('INSERT INTO projections VALUES(?,?,?)','rows','[{"symbol":"stale"}]',now());
  repo.projectNow();
  assert.equal(repo.projection('rows',[])[0].symbol,'T1');
  let notified=false;repo.onProjected=()=>notified=true;
  repo.project();repo.close();
  await delay(300);
  assert.equal(notified,false);
});

test('HTTP deltas expose new, repeat, and removed cards while full statistics stay pending',async()=>{
  const repo=new Repository(':memory:');
  repo.projectNow();
  let web;
  try{
    const ingestion=new IngestionService(repo,()=>web?.broadcast());
    web=createServer({repo,ingestion,statistics:{},market:{liveQuote:()=>null},collectors:{},bridge:{},port:0});
    if(!web.server.listening)await once(web.server,'listening');
    repo.onProjected=web.broadcast;
    const base=`http://127.0.0.1:${web.server.address().port}`;
    const request=route=>new Promise((resolve,reject)=>{
      get(base+route,{headers:{host:'127.0.0.1:0'}},response=>{
        let body='';response.setEncoding('utf8');
        response.on('data',chunk=>body+=chunk);
        response.on('end',()=>{try{assert.equal(response.statusCode,200);resolve(JSON.parse(body));}catch(error){reject(error);}});
      }).on('error',reject);
    });
    let delta=await request('/api/token-updates?since=0');
    assert.deepEqual(delta.changed,[]);
    const e=message(address(1),'http-new');ingestion.ingest(e);
    delta=await request('/api/token-updates?since='+delta.revision+'&epoch='+delta.epoch);
    assert.equal(delta.changed.length,1);
    assert.equal(delta.changed[0].pending,true);
    ingestion.ingest(message(address(1),'http-repeat',e.at+1));
    delta=await request('/api/token-updates?since='+delta.revision+'&epoch='+delta.epoch);
    assert.equal(delta.changed[0].firstSeen,e.at+1);
    ingestion.ingest({...e,kind:'delete',revision:e.at*1000+2});
    ingestion.ingest({...message(address(1),'http-repeat',e.at+1),kind:'delete',revision:(e.at+1)*1000+2});
    delta=await request('/api/token-updates?since='+delta.revision+'&epoch='+delta.epoch);
    assert.deepEqual(delta.removed,['bsc:'+address(1)]);
    assert.equal(repo.performanceSnapshot().timings.project.count,1);
    assert.equal((await request('/api/debug/performance')).build,'20261007-correction-icon-v5');
  }finally{
    if(web){web.server.closeAllConnections();await new Promise(resolve=>web.server.close(resolve));}
    repo.close();
  }
});
