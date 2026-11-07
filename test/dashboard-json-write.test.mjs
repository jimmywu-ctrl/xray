import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/ui/assets/dashboard.js',import.meta.url),'utf8');
function fixture(){
 const calls=[],start=source.indexOf('const api = async (p, opt) => {'),end=source.indexOf('\n};',start)+3;
 const ctx=vm.createContext({URL,location:{href:'http://127.0.0.1:48976/'},bulkApiTask:()=>'',observeMarketWork:()=>{},repairProgressReader:{invalidate(){}},fetch:async(p,opt)=>{calls.push({p,opt});return {ok:true,json:async()=>({ok:true})};}});
 vm.runInContext(source.slice(start,end)+';globalThis.callApi=api;',ctx);return {calls,request:ctx.callApi};
}
test('bodyless Bot check/test and source setup send valid JSON instead of receiving HTTP 415',async()=>{
 const {calls,request}=fixture();for(const p of ['/api/telegram-bot/check','/api/telegram-bot/test','/api/sources/wechat/setup'])await request(p,{method:'POST'});
 for(const c of calls){assert.equal(c.opt.headers['Content-Type'],'application/json');assert.equal(c.opt.body,'{}');}
});
test('JSON writes preserve supplied bodies/headers while GET remains a bodyless read',async()=>{
 const {calls,request}=fixture();await request('/api/settings',{method:'PUT',body:'{"opacity":1}',headers:{'X-Test':'yes'}});await request('/api/overview');
 assert.equal(calls[0].opt.body,'{"opacity":1}');assert.equal(calls[0].opt.headers['X-Test'],'yes');assert.equal(calls[1].opt,undefined);
});
