import {now,RECENT_WINDOW_SEC,CAPTURE_REFRESH_INTERVAL_SEC} from '../domain/rules.mjs';

/** Freeze the user-visible manual outcome before returning its job to automatic work. */
export function resumeAutomaticAfterManual(repo) {
  return repo.transaction(()=>{
    let batch=repo.setting('manualRepairBatchV1',null);
    const rows=repo.all(`SELECT j.*,p.baseline,p.peak,t.last_call,t.verified,c.active,c.version current_version
      FROM jobs j LEFT JOIN price_results p ON p.chain=j.chain AND p.address=j.address AND p.claim_version=j.claim_version
      LEFT JOIN tokens t ON t.chain=j.chain AND t.address=j.address
      LEFT JOIN claims c ON c.chain=j.chain AND c.address=j.address
      WHERE j.lane='capture' AND json_extract(j.payload,'$.manualBatchId') IS NOT NULL`);
    const groups=new Map();for(const row of rows){const id=JSON.parse(row.payload).manualBatchId;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(row);}
    let resumed=0;
    for(const [id,items] of groups){
      if(items.some(r=>['QUEUED','RUNNING','BACKOFF'].includes(r.state)||(r.state==='PARKED'&&['ave_api_key','baseline','verify','chain'].includes(r.wait))))continue;
      if(batch?.id===id){
        if(!Array.isArray(batch.rows))batch={...batch,rows:items.map(r=>({...r}))};
        if(batch.status==='running')batch={...batch,status:'complete',finishedAt:now()};
        repo.set('manualRepairBatchV1',batch);
      }
      for(const row of items){
        if(row.wait==='manual_stop'||!['DONE','FAILED','PARKED'].includes(row.state))continue;
        const payload=JSON.parse(row.payload);delete payload.manual;delete payload.manualBatchId;delete payload.manualAttempts;
        payload.failureAttempts=0;
        const active=row.active&&row.current_version===row.claim_version&&row.verified&&row.last_call>=now()-RECENT_WINDOW_SEC;
        if(row.state==='DONE'&&active&&row.baseline){
          payload.stage='history';payload.refresh=true;
          repo.run("UPDATE jobs SET payload=?,state='QUEUED',wait=NULL,due=?,attempts=0,last_error=NULL,updated_at=? WHERE id=? AND state='DONE'",JSON.stringify(payload),now()+CAPTURE_REFRESH_INTERVAL_SEC,now(),row.id);
          resumed++;
        }else repo.run('UPDATE jobs SET payload=? WHERE id=?',JSON.stringify(payload),row.id);
      }
    }
    return resumed;
  });
}
