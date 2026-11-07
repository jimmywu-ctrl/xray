const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {servicePaths,readLines,send}=require('./service-channel.cjs');
class MonitorClient extends EventEmitter {
  constructor({data,base,node,desktop,dispatch,log=()=>{},launch=true}){
    super();Object.assign(this,{data,base,node,desktop,dispatch,log,launch});
    this.paths=servicePaths(data);this.controllers=new Map();this.stopped=true;
  }
  start(){if(!this.stopped)return;this.stopped=false;this.connect();}
  launchService(){
    if(!this.launch||this.stopped||Date.now()-(this.lastLaunch||0)<10000)return;
    this.lastLaunch=Date.now();
    const env={...process.env,XRAY_DATA_DIR:this.data,FOMOMO_DATA_DIR:this.data,
      XRAY_DESKTOP_EXE:this.desktop?.exe||'',XRAY_DESKTOP_ARGS:JSON.stringify(this.desktop?.args||[])};
    const child=spawn(this.node,[path.join(this.base,'src','monitor-service.cjs')],{cwd:this.base,env,detached:true,windowsHide:true,stdio:'ignore'});
    child.on('error',error=>this.log('[service-launch] '+error.message+'\n'));child.unref();
  }
  connect(){
    if(this.stopped||this.socket)return;
    let state;
    try{state=JSON.parse(fs.readFileSync(this.paths.state,'utf8'));}catch{}
    if(!state||state.pipe!==this.paths.pipe||typeof state.token!=='string'){
      this.launchService();this.retry();return;
    }
    const socket=this.socket=net.createConnection(this.paths.pipe);
    const deadline=setTimeout(()=>socket.destroy(),3000);
    socket.on('error',()=>{});
    socket.on('connect',()=>send(socket,{type:'hello',token:state.token}));
    socket.on('close',()=>{
      clearTimeout(deadline);
      if(this.socket!==socket)return;
      this.socket=null;this.connected=false;
      for(const controller of this.controllers.values())controller.abort();this.controllers.clear();
      this.emit('disconnected');
      if(!this.stopped){this.launchService();this.retry();}
    });
    readLines(socket,message=>{
      if(this.socket!==socket||this.stopped)return;
      if(message.type==='hello'){clearTimeout(deadline);this.connected=true;this.emit('connected',message);return;}
      if(message.type==='service-stopped'){this.emit('service-stopped');return;}
      if(!this.connected)return;
      if(message.type==='cancel'){this.controllers.get(message.id)?.abort();this.controllers.delete(message.id);return;}
      if(message.type!=='request'||this.controllers.has(message.id))return;
      const controller=new AbortController();this.controllers.set(message.id,controller);
      Promise.resolve().then(()=>this.dispatch(message.method,{...message.params,_requestId:message.id},controller.signal))
        .then(result=>{if(!controller.signal.aborted&&this.socket===socket)send(socket,{type:'reply',id:message.id,result});})
        .catch(error=>{if(!controller.signal.aborted&&this.socket===socket)send(socket,{type:'reply',id:message.id,error:error.message});})
        .finally(()=>{if(this.controllers.get(message.id)===controller)this.controllers.delete(message.id);});
    });
  }
  retry(){clearTimeout(this.retryTimer);if(!this.stopped)this.retryTimer=setTimeout(()=>this.connect(),1000);}
  stopService(){
    if(!this.connected)return Promise.reject(Error('监控后台未连接，尚未确认停止'));
    return new Promise((resolve,reject)=>{
      let timer;
      const cleanup=()=>{clearTimeout(timer);this.off('service-stopped',finished);};
      const finished=()=>{cleanup();this.close();resolve();};
      this.once('service-stopped',finished);
      timer=setTimeout(()=>{cleanup();reject(Error('后台停止超时，请重试'));},10000);
      send(this.socket,{type:'stop'});
    });
  }
  close(){
    this.stopped=true;this.connected=false;clearTimeout(this.retryTimer);
    for(const controller of this.controllers.values())controller.abort();this.controllers.clear();
    this.socket?.destroy();this.socket=null;
  }
}
module.exports={MonitorClient};
