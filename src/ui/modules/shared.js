export const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const count=n=>Number(n||0).toLocaleString('zh-CN');
export const percent=(n,d)=>d?Math.round(n/d*100):0;
export function metric(label,value,detail,tone=''){return '<div class="module-metric '+tone+'"><span>'+escape(label)+'</span><strong>'+escape(value)+'</strong><small>'+escape(detail)+'</small></div>';}
export function coverage(label,n,total){return '<div class="module-coverage"><div><span>'+escape(label)+'</span><b>'+count(n)+' / '+count(total)+'</b></div><progress max="'+Math.max(1,total)+'" value="'+n+'" aria-label="'+escape(label)+'"></progress><small>'+percent(n,total)+'% 已取得</small></div>';}
export function setContent(id,html){const el=document.getElementById(id);if(el&&el.innerHTML!==html)el.innerHTML=html;}
export function acquisitionCounts(s){const jobs=s.jobs||[];const states=new Map();for(const j of jobs)states.set(j.state,(states.get(j.state)||0)+j.count);return {running:states.get('RUNNING')||0,queued:states.get('QUEUED')||0,missing:(states.get('PARKED')||0)+(states.get('FAILED')||0)};}
