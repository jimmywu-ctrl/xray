import {Worker} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';

export class BackgroundProjection {
  constructor(repo,{timeoutMs=30000}={}){this.timeoutMs=timeoutMs;this.repo=repo;this.version=0;this.serial=0;this.failures=0;this.stopped=false;}
  invalidate(){this.version++;this.schedule();}
  supersede(){this.version++;}
  schedule(delay=250){
    if(this.stopped||this.timer||this.flight||!this.repo.projectDirty)return;
    this.timer=setTimeout(()=>{this.timer=null;this.rebuild();},delay);this.timer.unref?.();
  }
  ensureWorker(){
    if(this.worker||this.stopped)return;
    // Statistics uses plain JS: do not duplicate the parent's tsx loader and compiler isolate.
    const worker=new Worker(new URL('./projection-thread.mjs',import.meta.url),{execArgv:[],workerData:{filename:this.repo.db.name}});
    this.worker=worker;worker.unref();
    worker.on('message',result=>this.receive(worker,result));
    worker.on('error',error=>this.failed(worker,error));
    worker.on('exit',code=>{if(!this.stopped&&this.worker===worker)this.failed(worker,Error(`statistics worker exited (${code})`));});
  }
  rebuild(){
    if(this.stopped||this.flight||!this.repo.db.open||!this.repo.projectDirty)return;
    try{this.ensureWorker();this.flight={id:++this.serial,version:this.version};this.worker.postMessage({id:this.flight.id});
      this.deadline=setTimeout(()=>this.failed(this.worker,Error("statistics rebuild timed out")),this.timeoutMs);this.deadline.unref?.();}
    catch(error){this.failed(this.worker,error);}
  }
  receive(worker,result){
    if(this.stopped||worker!==this.worker||result.id!==this.flight?.id)return;
    if(result.error){this.failed(worker,Error(result.error));return;}
    clearTimeout(this.deadline);this.deadline=null;
    const flight=this.flight;this.flight=null;this.failures=0;
    this.repo.recordPerformance('project_background',result.elapsedMs,result.snapshot.rows.length);
    if(flight.version===this.version){
      const started=performance.now();
      for(const [key,value] of Object.entries(result.snapshot))this.repo.projectionCache.set(key,value);
      this.repo.projectDirty=false;
      this.repo.recordPerformance('project_apply',performance.now()-started,result.snapshot.rows.length);
      this.repo.onProjected?.();
    }
    // An edit received during calculation invalidates the older result and queues one new snapshot.
    this.schedule();
  }
  failed(worker,error){
    if(this.stopped||worker!==this.worker)return;
    clearTimeout(this.deadline);this.deadline=null;
    this.worker=null;this.flight=null;this.repo.projectDirty=true;
    void worker?.terminate().catch(()=>{});
    console.error('[statistics] background rebuild failed:',error.message);
    this.schedule(Math.min(60000,1000*2**Math.min(this.failures++,6)));
  }
  stop(){clearTimeout(this.deadline);this.deadline=null;this.stopped=true;clearTimeout(this.timer);this.timer=null;const worker=this.worker;this.worker=null;this.flight=null;return worker?.terminate();}
  status(){return {enabled:!this.stopped,threadId:this.worker?.threadId??null,running:!!this.flight,retries:this.failures};}
}
