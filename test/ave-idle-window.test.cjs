const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {createIdleResource}=require('../desktop/idle-resource.cjs');
function clock(){
  let now=0;const tasks=new Map();
  return {setTimeout(fn,ms){const timer={unref(){}};tasks.set(timer,{fn,at:now+ms});return timer;},clearTimeout(timer){tasks.delete(timer);},
    advance(ms){const end=now+ms;while(true){const next=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=next[1].at;tasks.delete(next[0]);next[1].fn();}now=end;},get size(){return tasks.size;}};
}
test('five-minute idle release resets with activity and never retires active or queued operations',()=>{
  const timers=clock();let retired=0;const resource=createIdleResource({timers,retire(){retired++;}});
  const finish=resource.acquire();timers.advance(600000);assert.equal(retired,0);
  finish();timers.advance(299999);assert.equal(retired,0);
  const running=resource.acquire(),queued=resource.acquire();timers.advance(600000);assert.equal(retired,0);
  running();running();timers.advance(600000);assert.equal(retired,0,'a queued operation still holds a lease');
  queued();timers.advance(300000);assert.equal(retired,1);assert.equal(timers.size,0);
});
test('caller cancellation cannot retire underlying work early; shutdown cancels release timers',()=>{
  const timers=clock();let retired=0;const resource=createIdleResource({timers,retire(){retired++;}});
  const settle=resource.acquire();timers.advance(600000);assert.equal(retired,0);
  settle();assert.equal(timers.size,1);resource.stop();timers.advance(600000);assert.equal(retired,0);
  resource.acquire()();assert.equal(timers.size,0);
});
function fixture(){
  const timers=clock(),windows=[],partition={setPermissionRequestHandler(){}};
  class Window extends EventEmitter {
    constructor(options){super();this.options=options;this.destroyed=false;this.visible=false;
      this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};windows.push(this);}
    isDestroyed(){return this.destroyed;}isVisible(){return this.visible;}
    destroy(){this.destroyed=true;this.emit('closed');}loadURL(){return Promise.resolve();}
  }
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../desktop/sites.cjs'),'utf8'),{
    module,URL,AbortSignal,console,process:{platform:'win32'},require(name){
      if(name==='electron')return {BrowserWindow:Window,session:{fromPartition(p){assert.equal(p,'persist:xray-next-ave');return partition;}},safeStorage:{isEncryptionAvailable(){return false;}},app:{getPath(){return 'unused';}}};
      if(name==='./idle-resource.cjs')return {createIdleResource:options=>createIdleResource({...options,timers})};
      if(name==='./request-deadline.cjs')return require('../desktop/request-deadline.cjs');
      return require(name);
    },
  });
  return {sites:new module.exports.SiteSessions(),timers,windows};
}
test('idle AVE renderer is destroyed, then recreated hidden in the same persistent login partition',()=>{
  const {sites,timers,windows}=fixture(),template={session:'retained'};sites.aveTemplate=template;sites.aveSaved=template;
  const finish=sites.searchIdle.acquire(),first=sites.ensureAveSearch();finish();timers.advance(300000);
  assert.equal(first.isDestroyed(),true);assert.equal(sites.searchWindow,null);
  assert.equal(sites.aveTemplate,template);assert.equal(sites.aveSaved,template);
  const done=sites.searchIdle.acquire(),second=sites.ensureAveSearch();
  assert.notEqual(second,first);assert.equal(windows.length,2);assert.equal(second.options.show,false);
  assert.equal(second.options.webPreferences.partition,first.options.webPreferences.partition);
  done();sites.close();timers.advance(600000);assert.equal(timers.size,0);
});
test('a visible AVE window is retained until hidden and idle; unrelated login window is untouched',()=>{
  const {sites,timers}=fixture(),finish=sites.searchIdle.acquire(),search=sites.ensureAveSearch();
  let loginDestroyed=false;sites.windows.set('ave',{isDestroyed:()=>false,destroy(){loginDestroyed=true;}});
  search.visible=true;finish();timers.advance(300000);assert.equal(search.isDestroyed(),false);
  search.visible=false;timers.advance(300000);assert.equal(search.isDestroyed(),true);assert.equal(loginDestroyed,false);
  sites.close();
});
