import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export class AvatarCache {
  constructor({directory,ttlMs=86400000,memoryTtlMs=300000,maxMemoryBytes=8*1024*1024,maxDiskBytes=128*1024*1024,maxDiskEntries=2048,maxImageBytes=5*1024*1024,now=Date.now,pruneIntervalMs=60000}={}) {
    Object.assign(this,{directory,ttlMs,memoryTtlMs,maxMemoryBytes,maxDiskBytes,maxDiskEntries,maxImageBytes,now,pruneIntervalMs});
    this.memory=new Map();this.inFlight=new Map();this.memoryBytes=0;this.lastPrune=-Infinity;
  }
  filename(key){return path.join(this.directory,createHash('sha256').update(key).digest('hex')+'.avatar');}
  remember(key,image,expiresAt){
    const previous=this.memory.get(key);if(previous){this.memoryBytes-=previous.body.length;this.memory.delete(key);}
    if(image.body.length>this.maxMemoryBytes)return;
    while(this.memoryBytes+image.body.length>this.maxMemoryBytes&&this.memory.size){const oldest=this.memory.keys().next().value;this.memoryBytes-=this.memory.get(oldest).body.length;this.memory.delete(oldest);}
    this.memory.set(key,{...image,expiresAt,memoryUntil:Math.min(expiresAt,this.now()+this.memoryTtlMs)});this.memoryBytes+=image.body.length;
    this.scheduleMemoryPrune();
  }
  pruneMemory(){
    const now=this.now();
    for(const [key,entry] of this.memory)if(entry.memoryUntil<=now){this.memory.delete(key);this.memoryBytes-=entry.body.length;}
  }
  scheduleMemoryPrune(){
    if(this.memoryTimer||!this.memory.size)return;
    let next=Infinity;for(const entry of this.memory.values())next=Math.min(next,entry.memoryUntil);
    this.memoryTimer=setTimeout(()=>{this.memoryTimer=null;this.pruneMemory();this.scheduleMemoryPrune();},Math.max(1,next-this.now()));
    this.memoryTimer.unref?.();
  }
  close(){clearTimeout(this.memoryTimer);this.memoryTimer=null;this.memory.clear();this.memoryBytes=0;}
  async readDisk(key){
    if(!this.directory)return null;
    const filename=this.filename(key);
    try{
      const stat=await fs.stat(filename);if(stat.size>this.maxImageBytes+1024)throw Error('oversized cache entry');
      const data=await fs.readFile(filename),separator=data.indexOf(10);
      if(separator<0||separator>1024)throw Error('invalid cache header');
      const {contentType,expiresAt}=JSON.parse(data.subarray(0,separator).toString('utf8'));
      if(!Number.isFinite(expiresAt)||expiresAt<=this.now()||typeof contentType!=='string'||!contentType.startsWith('image/'))throw Error('expired cache entry');
      const body=data.subarray(separator+1);if(!body.length||body.length>this.maxImageBytes)throw Error('invalid image size');
      this.remember(key,{body,contentType},expiresAt);return {body,contentType,expiresAt};
    }catch{await fs.unlink(filename).catch(()=>{});return null;}
  }
  async writeDisk(key,image,expiresAt){
    if(!this.directory)return;
    await fs.mkdir(this.directory,{recursive:true});
    const filename=this.filename(key),temporary=filename+'.'+process.pid+'.'+randomUUID()+'.tmp';
    try{
      const header=Buffer.from(JSON.stringify({contentType:image.contentType,expiresAt})+'\n');
      await fs.writeFile(temporary,Buffer.concat([header,image.body]));
      await fs.rename(temporary,filename);
    }finally{await fs.unlink(temporary).catch(()=>{});}
    // Disk housekeeping never holds up the image response.
    void this.prune().catch(()=>{});
  }
  async prune(){
    if(this.pruning)return this.pruning;
    if(this.now()-this.lastPrune<this.pruneIntervalMs)return;
    this.lastPrune=this.now();
    const task=(async()=>{
      const names=await fs.readdir(this.directory),entries=[];
      for(const name of names){
        if(!/^[a-f0-9]{64}\.avatar$/.test(name))continue;
        const filename=path.join(this.directory,name),stat=await fs.stat(filename).catch(()=>null);
        if(stat)entries.push({filename,size:stat.size,mtime:stat.mtimeMs});
      }
      entries.sort((a,b)=>b.mtime-a.mtime);let bytes=0;
      for(const [index,entry] of entries.entries()){bytes+=entry.size;if(index>=this.maxDiskEntries||bytes>this.maxDiskBytes||this.now()-entry.mtime>this.ttlMs)await fs.unlink(entry.filename).catch(()=>{});}
    })();
    this.pruning=task;
    try{await task;}finally{if(this.pruning===task)this.pruning=null;}
  }
  async get(key,load){
    this.pruneMemory();
    const cached=this.memory.get(key);
    if(cached&&cached.expiresAt>this.now()){cached.memoryUntil=Math.min(cached.expiresAt,this.now()+this.memoryTtlMs);this.memory.delete(key);this.memory.set(key,cached);return cached;}
    if(cached){this.memory.delete(key);this.memoryBytes-=cached.body.length;}
    if(this.inFlight.has(key))return this.inFlight.get(key);
    const task=(async()=>{
      const disk=await this.readDisk(key);if(disk)return disk;
      const image=await load();
      if(!Buffer.isBuffer(image.body)||!image.body.length||image.body.length>this.maxImageBytes||!String(image.contentType).startsWith('image/'))throw Error('invalid avatar image');
      const expiresAt=this.now()+this.ttlMs;
      this.remember(key,image,expiresAt);
      await this.writeDisk(key,image,expiresAt).catch(()=>{});
      return image;
    })();
    this.inFlight.set(key,task);
    try{return await task;}finally{if(this.inFlight.get(key)===task)this.inFlight.delete(key);}
  }
}
