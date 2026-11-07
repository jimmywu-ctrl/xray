import {test} from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'node:http';
import {once} from 'node:events';
import {Repository} from '../src/infra/database.mjs';
import {createServer} from '../src/server.mjs';
test('startup readiness returns a tiny response without reading history or monitor state',async()=>{
  const repo=new Repository(':memory:');
  const {server}=createServer({repo,collectors:{status(){throw Error('not needed');}},market:{},bridge:{},port:0});
  try{
    if(!server.listening)await once(server,'listening');
    const all=repo.all,projection=repo.projection;
    repo.all=()=>{throw Error('must not query history');};repo.projection=()=>{throw Error('must not build history');};
    const request=host=>new Promise((resolve,reject)=>{get(`http://127.0.0.1:${server.address().port}/api/ready`,{headers:{host}},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>resolve({status:r.statusCode,body}));}).on('error',reject);});
    const result=await request('127.0.0.1:0');assert.equal(result.status,200);assert.deepEqual(JSON.parse(result.body),{ok:true});assert.ok(result.body.length<32);
    assert.equal((await request('example.com')).status,403);
    repo.all=all;repo.projection=projection;
  }finally{await new Promise(resolve=>server.close(resolve));repo.close();}
});
