import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/ui/assets/repair-progress.js',import.meta.url),'utf8');
function setup(request,clockDate=Date){const ctx=vm.createContext({api:request,Date:clockDate,Promise});vm.runInContext(source+';globalThis.createReader=createRepairProgressReader;',ctx);return ctx;}

test('concurrent progress reads share one request and cache expires after one second',async()=>{
 let calls=0,clock=0,resolve;
 const {createReader}=setup(()=>{});
 const reader=createReader(()=>{calls++;return new Promise(r=>resolve=r);},()=>clock);
 const a=reader.read(),b=reader.read();assert.equal(a,b);await Promise.resolve();assert.equal(calls,1);
 resolve({running:true});await a;await reader.read();assert.equal(calls,1);
 clock=1000;const next=reader.read();await Promise.resolve();assert.equal(calls,2);resolve({running:false});assert.equal((await next).running,false);
});

test('an action invalidates in-flight cached progress; a late old response cannot overwrite new state',async()=>{
 const {createReader}=setup(()=>{});const resolvers=[];
 const reader=createReader(()=>new Promise(r=>resolvers.push(r)));
 const old=reader.read();await Promise.resolve();reader.invalidate();const fresh=reader.read();await Promise.resolve();
 resolvers[1]({running:false});await fresh;resolvers[0]({running:true});await old;
 assert.equal((await reader.read()).running,false);
});

test('failed reads can retry without caching an error',async()=>{
 const {createReader}=setup(()=>{});let calls=0;
 const reader=createReader(()=>{if(++calls===1)throw Error('offline');return {running:false};});
 await assert.rejects(reader.read(),/offline/);assert.equal((await reader.read()).running,false);assert.equal(calls,2);
});

test('six inventory polls use 12 reads instead of 24, and manual refresh bypasses auxiliary cache',async()=>{
 let clock=0;const reads=[];
 const ctx=setup(async path=>{reads.push(path);return path.endsWith('/repair')?{running:false}:[];},{now:()=>clock});
 ctx.marketAuditLoading=false;
 ctx.document={getElementById:()=>null,querySelectorAll:()=>[],addEventListener:()=>{}};
 const inventory=fs.readFileSync(new URL('../src/ui/assets/inventory.js',import.meta.url),'utf8');
 vm.runInContext('var loadMarketAudit;'+inventory+';globalThis.readInventory=loadMarketAudit;',ctx);
 for(clock=0;clock<=10000;clock+=2000)await ctx.readInventory({force:false});
 assert.equal(reads.length,12); // six progress reads + two sets of three auxiliary reads
 // The first 10s interval [0,10s) is five polls: 5 + 3 = 8 vs the previous 20 reads.
 assert.equal(reads.filter(p=>p.endsWith('/repair')).length,6);
 const before=reads.length;await ctx.readInventory();assert.equal(reads.length-before,4);
});
