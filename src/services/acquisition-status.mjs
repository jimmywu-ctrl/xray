/** Describe current work from its job, rather than guessing from old diagnostics. */
export function acquisitionStatus(job = {}, time = Math.floor(Date.now()/1000)) {
  const payload=typeof job.payload==='string'?JSON.parse(job.payload||'{}'):(job.payload||{});
  const reason=String(job.last_error||'');
  if(job.state==='QUEUED'&&job.due>time&&payload.stage==='history'&&!payload.manualBatchId)
    return {key:payload.refresh?'scheduledRefresh':'waitingQuiet',label:payload.refresh?'等待下一次增量补查':'等待首轮历史补查',dueAt:job.due};
  if(job.state==='BACKOFF')return {key:'retrying',label:/会话|登录|session/i.test(reason)?'等待AVE网页会话恢复':/429|限流/i.test(reason)?'平台限流，等待继续':'网络或查询异常，等待重试',dueAt:job.due};
  if(['QUEUED','RUNNING'].includes(job.state))return {key:'querying',label:job.state==='RUNNING'?'正在查询':'等待查询'};
  if(job.wait==='nodata')return {key:'noData',label:Number(payload.automaticRechecks||0)>=4?'暂无可用K线，自动复查已达上限，可手动补查':'平台暂无可用K线，等待低频复查'};
  if(job.wait==='limit')return {key:'failed',label:Number(payload.automaticRechecks||0)<4?'连续查询失败，冷却后低频复查':'自动复查已达上限，可手动补查'};
  if(job.state==='FAILED')return {key:'failed',label:'查询失败，已停止，可手动补查'};
  if(job.wait==='manual_stop')return {key:'stopped',label:'本轮已手动停止'};
  if(['chain','manual_review'].includes(job.wait))return {key:'chain',label:'地址所属链待核对'};
  if(job.state==='DONE')return {key:'complete',label:'本轮已完成'};
  return {key:'other',label:'缺少计算所需行情'};
}
