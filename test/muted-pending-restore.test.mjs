import test from 'node:test';
import assert from 'node:assert/strict';
import {Repository} from '../src/infra/database.mjs';
import {DashboardContract} from '../src/services/dashboard-contract.mjs';
const address='0x'+'a'.repeat(40);
test('pending tokens absent from statistics remain listed and restorable after muting',async()=>{
 const repo=new Repository(':memory:');try{
  repo.run('INSERT INTO tokens(chain,address,last_call,metadata) VALUES(?,?,?,?)','?',address,1,JSON.stringify({symbol:'待确认'}));
  const d=new DashboardContract(repo,null,{},null,()=>{}),url=new URL('http://localhost/api/monitor-mutes');
  const muted=await d.handle({method:'POST'},url,{chain:'?',address,muted:true});
  assert.equal(repo.projection('rows',[]).length,0);assert.equal(muted.length,1);assert.equal(muted[0].address,address);
  assert.equal(muted[0].symbol,'待确认');assert.equal((await d.handle({method:'POST'},url,{chain:'?',address,muted:false})).length,0);
 }finally{repo.close();}
});
test('expired or removed token keys can still be restored without losing other mutes',async()=>{
 const repo=new Repository(':memory:');try{
  const d=new DashboardContract(repo,null,{},null,()=>{}),url=new URL('http://localhost/api/monitor-mutes');
  repo.set('monitorMutes',['bsc:'+address,'?:'+address]);
  const list=await d.handle({method:'GET'},url,{});assert.equal(list.length,2);
  const left=await d.handle({method:'POST'},url,{chain:'bsc',address,muted:false});
  assert.equal(left.length,1);assert.equal(left[0].chain,'?');
 }finally{repo.close();}
});
