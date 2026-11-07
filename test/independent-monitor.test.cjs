const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {once}=require('node:events');
const {PassThrough}=require('node:stream');
const {MonitorSupervisor}=require('../src/infra/monitor-supervisor.cjs');
const {MonitorClient}=require('../src/infra/monitor-client.cjs');
const {readLines,send}=require('../src/infra/service-channel.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=6000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await delay(25);}throw Error('condition timed out');}
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
async function fixture(run,{autoHost=false}={}){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'xray-independent-'));
  const backend=path.join(data,'backend.cjs'),host=path.join(data,'host.cjs'),heartbeat=path.join(data,'heartbeat.json');
  fs.writeFileSync(backend,`
    const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
    const data=process.env.XRAY_DATA_DIR;let ticks=0,replies=0;
    fs.writeFileSync(path.join(data,'backend-runtime.json'),JSON.stringify({pid:process.pid}));
    setInterval(()=>fs.writeFileSync(path.join(data,'heartbeat.json'),JSON.stringify({pid:process.pid,ticks:++ticks,replies})),50);
    const r=readline.createInterface({input:process.stdin});r.on('close',()=>process.exit(0));
    r.on('line',line=>{const m=JSON.parse(line);if(m.type==='reply'&&!m.error)replies++;});
    console.log('fixture log that is not a bridge message');
    console.log(JSON.stringify({type:'request',id:1,method:'ave.query',params:{address:'fixture'}}));
  `);
  fs.writeFileSync(host,`
    const fs=require('node:fs');
    const {MonitorClient}=require(${JSON.stringify(require.resolve('../src/infra/monitor-client.cjs'))});
    const client=new MonitorClient({data:${JSON.stringify(data)},base:${JSON.stringify(data)},node:process.execPath,launch:false,dispatch:async()=>({ok:true})});
    fs.writeFileSync(${JSON.stringify(path.join(data,'host-start.json'))},JSON.stringify({pid:process.pid,hidden:process.argv.includes('--background-only')}));
    client.on('disconnected',()=>{client.close();process.exit(0);});client.start();
  `);
  const service=new MonitorSupervisor({data,base:data,node:process.execPath,desktop:autoHost?{exe:process.execPath,args:[host]}:null,backendEntry:backend,backendArgs:[],restartBaseMs:50});
  try{await service.start();await until(()=>read(heartbeat));await run({service,data,heartbeat});}
  finally{await service.stop();const launched=read(path.join(data,'host-start.json'));if(launched){await delay(100);try{process.kill(launched.pid);}catch{}}
    await delay(50);fs.rmSync(data,{recursive:true,force:true});}
}
test('desktop disconnect/reconnect preserves monitoring, rejects unauthenticated stop, restarts crashed backend, and stops explicitly',()=>fixture(async({service,data,heartbeat})=>{
  const client=new MonitorClient({data,base:data,node:process.execPath,launch:false,dispatch:async()=>({ok:true})});
  try{
    client.start();await until(()=>read(heartbeat)?.replies===1);const originalPid=service.child.pid;
    client.close();await until(()=>!service.desktopSocket);const ticks=read(heartbeat)?.ticks??0;
    await until(()=>read(heartbeat)?.ticks>ticks+2);assert.equal(service.child.pid,originalPid);
    const bad=net.createConnection(service.paths.pipe);bad.on('error',()=>{});await once(bad,'connect');
    const closed=once(bad,'close');send(bad,{type:'hello',token:'wrong'});send(bad,{type:'stop'});await closed;
    assert.equal(service.stopping,false);assert.equal(service.child.pid,originalPid);
    client.start();await until(()=>client.connected);assert.equal(service.child.pid,originalPid);
    const second=new MonitorSupervisor({data,base:data});await assert.rejects(second.start(),e=>e.code==='XRAY_SERVICE_EXISTS');
    service.child.kill();await until(()=>service.child&&service.child.pid!==originalPid);
    await until(()=>read(heartbeat)?.pid===service.child.pid&&read(heartbeat)?.replies===1);
    await client.stopService();await service.stopPromise;assert.equal(service.child,null);assert.equal(fs.existsSync(service.paths.state),false);
    await delay(150);assert.equal(service.child,null,'explicit stop cannot restart');
  }finally{client.close();}
}));
test('AVE work with no interface starts only a background host and receives its reply',()=>fixture(async({service,data,heartbeat})=>{
  await until(()=>read(path.join(data,'host-start.json'))&&read(heartbeat)?.replies===1);
  assert.equal(read(path.join(data,'host-start.json')).hidden,true);assert.equal(service.requests.size,0);
},{autoHost:true}));
test('IPC framing preserves split UTF-8 and rejects oversized input',()=>{
  const stream=new PassThrough(),messages=[];readLines(stream,m=>messages.push(m));
  const data=Buffer.from(JSON.stringify({label:'首喊监控'})+'\n');const at=data.indexOf(Buffer.from('首'))+1;
  stream.write(data.subarray(0,at));stream.write(data.subarray(at));assert.deepEqual(messages,[{label:'首喊监控'}]);
  const oversized=new PassThrough();readLines(oversized,()=>assert.fail('must reject'));
  oversized.write(Buffer.alloc(8*1024*1024+1,65));assert.equal(oversized.destroyed,true);stream.destroy();
});
