import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AvatarCache} from '../src/services/avatar-cache.mjs';

const image=()=>({body:Buffer.from('image bytes'),contentType:'image/png'});
async function fixture(run){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'xray-avatar-'));const caches=[];const make=opts=>{const cache=new AvatarCache({directory,...opts});caches.push(cache);return cache;};try{await run(make,directory);}finally{for(const c of caches){c.close();await c.pruning?.catch(()=>{});}await fs.rm(directory,{recursive:true,force:true});}}

test('concurrent avatar requests share one download and a new cache instance reuses disk',()=>fixture(async(make)=>{
  let loads=0;const cache=make();
  const results=await Promise.all(Array.from({length:20},()=>cache.get('https://source/avatar',async()=>{loads++;await new Promise(r=>setTimeout(r,10));return image();})));
  assert.equal(loads,1);assert.ok(results.every(r=>r.body.equals(image().body)));
  const restarted=make();assert.ok((await restarted.get('https://source/avatar',()=>{throw Error('network must not be used');})).body.equals(image().body));
}));
test('a failed shared download is retryable rather than permanently poisoning the cache',()=>fixture(async(make)=>{
  const cache=make();let loads=0;
  const failed=await Promise.allSettled(Array.from({length:8},()=>cache.get('failure',async()=>{loads++;throw Error('offline');})));
  assert.equal(loads,1);assert.ok(failed.every(r=>r.status==='rejected'));assert.equal(cache.inFlight.size,0);
  await cache.get('failure',async()=>{loads++;return image();});assert.equal(loads,2);
}));
test('expired or corrupt disk entries refresh, while memory eviction preserves byte accounting',()=>fixture(async(make,directory)=>{
  let now=Date.now();const cache=make({ttlMs:100,now:()=>now,maxMemoryBytes:15});let loads=0;
  await cache.get('first',async()=>{loads++;return image();});await cache.pruning;
  now+=101;await cache.get('first',async()=>{loads++;return image();});assert.equal(loads,2);
  const reopened=make({now:()=>now,maxMemoryBytes:15});
  await fs.writeFile(reopened.filename('corrupt'),'not an image cache');
  await reopened.get('corrupt',async()=>{loads++;return image();});assert.equal(loads,3);
  await reopened.get('other',async()=>image());assert.equal(reopened.memory.size,1);assert.equal(reopened.memoryBytes,image().body.length);
  assert.ok((await fs.readdir(directory)).some(n=>n.endsWith('.avatar')));
}));
test('disk capacity is pruned and cache write failures do not break successful images',()=>fixture(async(make,directory)=>{
  const cache=make({maxDiskBytes:550,pruneIntervalMs:0});
  for(let i=0;i<4;i++){await cache.get('key'+i,async()=>({body:Buffer.alloc(400),contentType:'image/png'}));await cache.pruning;}
  const files=(await fs.readdir(directory)).filter(n=>n.endsWith('.avatar'));
  let bytes=0;for(const name of files)bytes+=(await fs.stat(path.join(directory,name))).size;assert.ok(bytes<=550);
  const blocked=path.join(directory,'file');await fs.writeFile(blocked,'x');
  const unavailable=new AvatarCache({directory:blocked});assert.ok((await unavailable.get('ok',async()=>image())).body.equals(image().body));
}));
