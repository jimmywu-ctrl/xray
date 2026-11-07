const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(fetch){
  const calls=[],session={fetch,setProxy:async c=>calls.push(c),closeAllConnections:async()=>{}};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../desktop/sites.cjs'),'utf8'),{
    module,URL,AbortSignal,console:{error(){}},process:{platform:'win32'},
    require(name){
      if(name==='./request-deadline.cjs')return require('../desktop/request-deadline.cjs');
      if(name==='./idle-resource.cjs')return require('../desktop/idle-resource.cjs');
      if(name==='electron')return {session:{fromPartition(name){assert.equal(name,'persist:xray-next-ave');return session;}},safeStorage:{isEncryptionAvailable(){return false;}},app:{getPath(){return 'unused';}}};
      if(name==='node:child_process')return {execFile(_file,_args,_opts,cb){cb(null,'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ 127.0.0.1:7890\n');}};
      return require(name);
    },
  });
  return {sites:new module.exports.SiteSessions(),calls};
}
test('AVE partition explicitly uses the current Windows proxy and caches configuration',async()=>{
  const {sites,calls}=fixture();await sites.configureAveNetwork();await sites.configureAveNetwork();
  assert.equal(calls.length,1);assert.equal(calls[0].mode,'fixed_servers');assert.equal(calls[0].proxyRules,'127.0.0.1:7890');
});
test('closed and HTML-only mirrors fall back to a valid AVE JSON node and retain query parameters',async()=>{
  const hosts=[],template={url:'https://gj99z.com/v2api/token_info/v1/token/detail',headers:{'X-Auth':'fixture-only'}};
  const {sites}=fixture(async(raw,options)=>{
    const u=new URL(raw);hosts.push(u.host);assert.equal(u.searchParams.get('token_id'),'fixture-bsc');assert.equal(options.headers,template.headers);
    if(u.host==='gj99z.com')throw Error('net::ERR_CONNECTION_CLOSED');
    return {status:200,text:async()=>u.host==='yiyulu.com'?'<html>unavailable</html>':JSON.stringify({status:1,data:{token:{price:1}}})};
  });
  const u=new URL(template.url);u.searchParams.set('token_id','fixture-bsc');
  const result=await sites.fetchAveWithFallback(u,template);
  assert.deepEqual(hosts,['gj99z.com','yiyulu.com','ccwlsc.com']);assert.equal(result.payload.status,1);assert.equal(new URL(sites.aveTemplate.url).host,'ccwlsc.com');
});
test('authentication and rate-limit responses are returned without mirror retries',async()=>{
  for(const status of [401,403,429]){
    let calls=0;const {sites}=fixture(async()=>{calls++;return {status,text:async()=>JSON.stringify({status:0})};});
    const r=await sites.fetchAveWithFallback(new URL('https://gj99z.com/query'),{headers:{}});
    assert.equal(r.res.status,status);assert.equal(calls,1);
  }
});
