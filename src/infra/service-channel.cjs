const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
function servicePaths(data){
  const id=crypto.createHash('sha256').update(path.resolve(data).toLowerCase()).digest('hex').slice(0,24);
  return {state:path.join(data,'monitor-service.json'),lock:path.join(data,'monitor-service.lock.sqlite'),
    pipe:process.platform==='win32'?`\\\\.\\pipe\\xray-monitor-${id}`:path.join(data,'monitor-service.sock')};
}
function readLines(stream,onMessage,onInvalid=()=>stream.destroy()){
  const decoder=new StringDecoder('utf8');let pending='';
  const receive=chunk=>{
    pending+=decoder.write(chunk);
    if(Buffer.byteLength(pending)>8*1024*1024){pending='';const error=Error('IPC frame too large');error.code='FRAME_TOO_LARGE';onInvalid(error);return;}
    let at;
    while((at=pending.indexOf('\n'))!==-1){
      const line=pending.slice(0,at);pending=pending.slice(at+1);if(!line.trim())continue;
      try{onMessage(JSON.parse(line));}catch(error){onInvalid(error);if(stream.destroyed)return;}
    }
  };
  stream.on('data',receive);return ()=>{stream.off('data',receive);pending='';};
}
function send(stream,message){
  if(!stream||stream.destroyed||!stream.writable)return false;
  // A stalled peer cannot accumulate an unbounded queue of AVE responses.
  if(stream.writableLength>8*1024*1024){stream.destroy();return false;}
  stream.write(JSON.stringify(message)+'\n');return true;
}
function writeState(filename,state){
  const temporary=filename+'.'+process.pid+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(state),{mode:0o600});
  fs.renameSync(temporary,filename);
}
module.exports={servicePaths,readLines,send,writeState};
