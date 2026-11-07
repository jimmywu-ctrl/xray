const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {servicePaths,readLines,send,writeState}=require('./service-channel.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class MonitorSupervisor {
  constructor({data,base,node=process.execPath,desktop=null,backendEntry='src/main.mjs',backendArgs=['--import','tsx'],port=48876,restartBaseMs=1000,heartbeatMs=15000}){
    Object.assign(this,{data,base,node,desktop,backendEntry,backendArgs,port,restartBaseMs,heartbeatMs});
    this.paths=servicePaths(data);this.token=crypto.randomBytes(32).toString('hex');this.requests=new Map();
    this.sockets=new Set();this.stopping=false;this.failures=0;this.startedAt=Date.now();
  }
  log(message){
    try{const file=path.join(this.data,'monitor-service.log');
      if(fs.existsSync(file)&&fs.statSync(file).size>5*1024*1024){try{fs.renameSync(file,file+'.old');}catch{fs.truncateSync(file,0);}}
      fs.appendFileSync(file,String(message));
    }catch{}
  }
  state(){return {version:1,pid:process.pid,backendPid:this.child?.pid??null,pipe:this.paths.pipe,token:this.token,startedAt:this.startedAt,stopping:this.stopping};}
  persist(){writeState(this.paths.state,this.state());}
  async start(){
    fs.mkdirSync(this.data,{recursive:true});
    this.lock=new DatabaseSync(this.paths.lock,{timeout:0});
    try{this.lock.exec('BEGIN EXCLUSIVE');}catch(error){this.lock.close();this.lock=null;error.code='XRAY_SERVICE_EXISTS';throw error;}
    try{
      // A previous supervisor may have died just before its stdin-owned backend
      // finished shutting down. Never open a second live monitoring database.
      let previous;
      try{previous=JSON.parse(fs.readFileSync(path.join(this.data,'backend-runtime.json'),'utf8'));}catch{}
      if(previous?.pid&&previous.pid!==process.pid){
        for(let n=0;n<50;n++){
          let alive=false;try{process.kill(previous.pid,0);alive=true;}catch{}
          if(!alive)break;
          if(n===49)throw Error('旧监控进程仍在运行，未重复启动监控');
          await delay(100);
        }
      }
      if(process.platform!=='win32'&&fs.existsSync(this.paths.pipe))fs.unlinkSync(this.paths.pipe);
      this.server=net.createServer(socket=>this.accept(socket));
      await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.paths.pipe,resolve);});
      this.server.on('error',error=>this.log('[service] '+error.message+'\n'));
      this.persist();this.spawnBackend();
      this.heartbeat=setInterval(()=>void this.checkHealth(),this.heartbeatMs);
      this.exitSignal=()=>void this.stop();process.on('SIGTERM',this.exitSignal);process.on('SIGINT',this.exitSignal);
    }catch(error){this.server?.close();this.lock?.close();this.lock=null;throw error;}
  }
  accept(socket){
    this.sockets.add(socket);let authenticated=false;
    const authDeadline=setTimeout(()=>socket.destroy(),3000);
    socket.on('error',()=>{});
    socket.on('close',()=>{clearTimeout(authDeadline);this.sockets.delete(socket);if(this.desktopSocket===socket)this.desktopSocket=null;});
    readLines(socket,message=>{
      if(!authenticated){
        const given=Buffer.from(String(message.token||''));const expected=Buffer.from(this.token);
        if(message.type!=='hello'||given.length!==expected.length||!crypto.timingSafeEqual(given,expected)){socket.destroy();return;}
        authenticated=true;clearTimeout(authDeadline);
        if(this.desktopSocket&&this.desktopSocket!==socket)this.desktopSocket.destroy();
        this.desktopSocket=socket;send(socket,{type:'hello',backendPid:this.child?.pid??null});
        for(const request of this.requests.values())send(socket,request);
        return;
      }
      if(this.desktopSocket!==socket)return;
      if(message.type==='stop'){void this.stop();return;}
      if(message.type==='reply'&&this.requests.has(message.id)){
        this.requests.delete(message.id);send(this.child?.stdin,message);
      }
    });
  }
  ensureDesktop(){
    if(this.stopping||this.desktopSocket||!this.desktop||Date.now()-(this.lastDesktopLaunch||0)<10000)return;
    this.lastDesktopLaunch=Date.now();
    const host=spawn(this.desktop.exe,[...this.desktop.args,'--background-only'],{cwd:this.base,detached:true,windowsHide:true,stdio:'ignore'});
    host.on('error',error=>this.log('[desktop-host] '+error.message+'\n'));host.unref();
  }
  spawnBackend(){
    if(this.stopping)return;
    const child=this.child=spawn(this.node,[...this.backendArgs,this.backendEntry],{cwd:this.base,windowsHide:true,
      env:{...process.env,XRAY_DATA_DIR:this.data,FOMOMO_DATA_DIR:this.data,XRAY_PORT:String(this.port)},stdio:['pipe','pipe','pipe']});
    this.backendStartedAt=Date.now();this.healthFailures=0;this.persist();
    child.stdin.on('error',()=>{});child.stderr.on('data',data=>this.log(data));
    readLines(child.stdout,message=>{
      if(this.child!==child||this.stopping)return;
      if(message.type==='cancel'){this.requests.delete(message.id);send(this.desktopSocket,message);return;}
      if(message.type!=='request')return;
      if(this.requests.size>=100){send(child.stdin,{type:'reply',id:message.id,error:'桌面请求队列已满'});return;}
      if(!this.desktopSocket&&!['ave.query','ave.search-address'].includes(message.method)){
        send(child.stdin,{type:'reply',id:message.id,error:'界面未连接，请打开 X-Ray 后重试'});return;
      }
      this.requests.set(message.id,message);
      if(!send(this.desktopSocket,message))this.ensureDesktop();
    },error=>{if(error?.code==='FRAME_TOO_LARGE')child.kill();else this.log('[service] ignored non-protocol backend output\n');});
    let finished=false;
    const exited=(code,signal)=>{
      if(finished)return;finished=true;
      if(this.child===child)this.child=null;
      for(const id of this.requests.keys())send(this.desktopSocket,{type:'cancel',id});this.requests.clear();
      if(this.stopping)return;
      if(Date.now()-this.backendStartedAt>60000)this.failures=0;
      const wait=Math.min(30000,this.restartBaseMs*2**Math.min(this.failures++,5));
      this.log(`[service] backend exited (${code??signal}); restart in ${wait}ms\n`);
      this.persist();this.restartTimer=setTimeout(()=>this.spawnBackend(),wait);
    };
    child.once('error',error=>{this.log('[service] '+error.message+'\n');exited('spawn-error');});
    child.once('exit',exited);
  }
  async checkHealth(){
    if(this.stopping||this.checking||!this.child||Date.now()-this.backendStartedAt<20000)return;
    this.checking=true;const child=this.child;
    try{
      const response=await fetch(`http://127.0.0.1:${this.port}/api/ready`,{signal:AbortSignal.timeout(2000)});
      const ready=response.ok&&(await response.json()).ok===true;
      if(!ready)throw Error('monitor is not ready');
      if(this.child===child)this.healthFailures=0;
    }catch{
      if(this.child===child&&++this.healthFailures>=3&&!this.stopping){this.log('[service] backend unresponsive; restarting\n');child.kill();}
    }finally{this.checking=false;}
  }
  stop(){
    if(this.stopPromise)return this.stopPromise;
    this.stopPromise=(async()=>{
      this.stopping=true;clearTimeout(this.restartTimer);clearInterval(this.heartbeat);this.persist();
      const child=this.child;
      if(child){
        const exited=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();
        let force;try{await Promise.race([exited,new Promise(resolve=>{force=setTimeout(()=>{child.kill();resolve();},5000);})]);}
        finally{clearTimeout(force);}
        if(child.exitCode===null&&child.signalCode===null)await Promise.race([exited,delay(2000)]);
      }
      send(this.desktopSocket,{type:'service-stopped'});
      for(const socket of this.sockets)socket.end();
      this.requests.clear();
      await new Promise(resolve=>{this.server?.close(resolve);for(const socket of this.sockets)socket.destroySoon();});
      try{const saved=JSON.parse(fs.readFileSync(this.paths.state,'utf8'));if(saved.token===this.token)fs.unlinkSync(this.paths.state);}catch{}
      this.lock?.close();this.lock=null;
      process.off('SIGTERM',this.exitSignal);process.off('SIGINT',this.exitSignal);
    })();return this.stopPromise;
  }
}
module.exports={MonitorSupervisor};
