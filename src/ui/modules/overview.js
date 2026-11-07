import {count,setContent,acquisitionCounts} from './shared.js';

export function renderOverview(s){
  const rows=s.rows||[];
  const active=rows.filter(r=>r.lastCall>=s.time-24*3600).length;
  const jobs=acquisitionCounts(s),running=jobs.running>0,queued=jobs.queued>0;
  const state=running?`正在补查 ${count(jobs.running)} 项`:queued?`等待补查 ${count(jobs.queued)} 项`:'补查空闲';
  setContent('module-overview',
    '<div class="iv-system-status" role="status"><span class="iv-system-dot '+(running?'active':'')+'"></span><strong>'+state+'</strong><span>近 24 小时有 '+count(active)+' 个代币被喊</span><span>悬浮窗行情实时刷新</span></div>');
}
