const path=require('node:path'),os=require('node:os');
const {MonitorSupervisor}=require('./infra/monitor-supervisor.cjs');
const data=process.env.XRAY_DATA_DIR||path.join(process.env.APPDATA||os.homedir(),'xray-next');
let desktop=null;
if(process.env.XRAY_DESKTOP_EXE)desktop={exe:process.env.XRAY_DESKTOP_EXE,args:JSON.parse(process.env.XRAY_DESKTOP_ARGS||'[]')};
const supervisor=new MonitorSupervisor({data,base:path.resolve(__dirname,'..'),node:process.execPath,desktop});
supervisor.start().catch(error=>{console.error(error.message);process.exitCode=error.code==='XRAY_SERVICE_EXISTS'?0:1;});
