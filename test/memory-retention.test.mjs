import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AvatarCache} from '../src/services/avatar-cache.mjs';
import {Repository} from '../src/infra/database.mjs';
import {IngestionService} from '../src/services/ingestion.mjs';
import {DashboardContract} from '../src/services/dashboard-contract.mjs';
import {now,RECENT_WINDOW_SEC} from '../src/domain/rules.mjs';

test('idle avatars leave memory while disk reuse avoids another network download',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'xray-memory-'));
  let clock=Date.now(),loads=0;
  const cache=new AvatarCache({directory,now:()=>clock,memoryTtlMs:50});
  const load=async()=>{loads++;return {body:Buffer.alloc(1024),contentType:'image/png'};};
  try{
    await cache.get('avatar',load);assert.equal(cache.memoryBytes,1024);
    clock+=30;await cache.get('avatar',load);
    clock+=30;cache.pruneMemory();assert.equal(cache.memoryBytes,1024,'active image keeps its hot cache');
    clock+=51;cache.pruneMemory();assert.equal(cache.memoryBytes,0);
    await cache.get('avatar',load);assert.equal(loads,1);assert.equal(cache.memoryBytes,1024);
  }finally{cache.close();await cache.pruning;await fs.rm(directory,{recursive:true,force:true});}
});
test('idle avatar buffers are released without requiring a subsequent request',async()=>{
  const cache=new AvatarCache({memoryTtlMs:20});
  try{await cache.get('avatar',async()=>({body:Buffer.alloc(1024),contentType:'image/png'}));
    await new Promise(resolve=>setTimeout(resolve,60));assert.equal(cache.memoryBytes,0);assert.equal(cache.memory.size,0);
  }finally{cache.close();}
});
test('a quiet monitor ages expired mention caches without losing first-call attribution',()=>{
  const repo=new Repository(':memory:'),ingestion=new IngestionService(repo),dashboard=new DashboardContract(repo,{}, {}, {},()=>{});
  const original=Date.now;let clock=original();Date.now=()=>clock;
  try{
    ingestion.ingest({group:'tg:123',sourceId:'one',time:now()-100,chainHint:'bsc',addrs:['0x'+'1'.repeat(40)],sender:'first'});
    repo.run('UPDATE tokens SET verified=1');
    const tokens=dashboard.tokens();assert.equal(tokens[0].mentions[0].sender,'first');
    const revision=repo.mentionsRevision;clock+=(RECENT_WINDOW_SEC+1)*1000;
    assert.equal(dashboard.tokens().length,0);assert.equal(dashboard.mentionsByToken.size,0);assert.equal(repo.mentionsRevision,revision);
    assert.equal(dashboard.cachedMentions,undefined,'raw query rows are not held alongside DTOs');
  }finally{Date.now=original;repo.close();}
});
