import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {get} from 'node:http';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {createServer} from '../src/server.mjs';
import {now} from '../src/domain/rules.mjs';
test('restarted backends reset matching numeric cursors using a distinct epoch, then resume deltas',async()=>{
  const repo=new Repository(':memory:'),ingestion=new IngestionService(repo);let server;
  const start=async()=>{const web=createServer({repo,ingestion,collectors:{},market:{},bridge:{},port:0});server=web.server;if(!server.listening)await once(server,'listening');return web;};
  const read=(since=0,epoch='')=>new Promise((resolve,reject)=>get(`http://127.0.0.1:${server.address().port}/api/token-updates?since=${since}&epoch=${epoch}`,{headers:{host:'127.0.0.1:0'}},r=>{let data='';r.on('data',b=>data+=b);r.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject));
  const stop=()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
  try{
    const firstWeb=await start();
    ingestion.ingest({group:'tg:123',sourceId:'one',time:now(),chainHint:'bsc',addrs:['0x'+'1'.repeat(40)],sender:'audit'});firstWeb.broadcast();
    const before=await read();assert.equal(before.changed.length,1);assert.equal(before.reset,true);
    assert.equal((await read(before.revision,before.epoch)).changed.length,0);
    await stop();await start();
    const after=await read(before.revision,before.epoch);
    assert.equal(after.revision,before.revision,'numeric cursors deliberately collide');
    assert.notEqual(after.epoch,before.epoch);assert.equal(after.reset,true);assert.equal(after.changed.length,1);
    const next=await read(after.revision,after.epoch);assert.equal(next.reset,false);assert.equal(next.changed.length,0);
    assert.equal((await read(after.revision)).reset,true,'legacy clients are given a safe complete snapshot');
  }finally{await stop();repo.close();}
});
