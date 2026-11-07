/* Stored results and explicit query progress. Page reads never enqueue work. */
let inventorySignature='';
const inventoryEscape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function renderInventorySummary(repair,reasons,candidates=[],ignored=[]){
 const host=document.getElementById('data-inventory');if(!host)return;
 const total=Number(reasons?.total)||0,ready=Number(reasons?.ready)||0,missing=Number(reasons?.missing)||0;
 const noBase=Number(reasons?.noBase)||0,noPeak=Number(reasons?.noPeak)||0;
 const labels={waitingQuiet:'等待下一次历史补查',scheduledRefresh:'等待下一次增量补查',retrying:'网络异常、限流或会话等待，稍后继续',failed:'查询失败已停止，可手动补查',stopped:'本轮已手动停止',archived:'喊单时间较早，超出可查询范围',chain:'地址所属链还未确认',timeout:'行情平台响应超时',interrupted:'查询中断，结果未完整',noData:'平台没有返回可用K线，已挂起',querying:'正在查询或排队',other:'还缺计算倍数所需的价格'};
 const running=!!repair.running,n=Number(repair.phaseTotal)||0,done=Math.min(n,Number(repair.phaseCompleted)||0),remaining=Number(repair.remaining)||0;
 const percent=n?Math.min(100,Math.round(done/n*100)):0,available=total?Math.min(100,Math.round(ready/total*100)):0;
 const entries=Object.entries(labels).map(([key,label])=>[key,Number(reasons?.[key])||0,label]).filter(([,amount])=>amount>0).sort((a,b)=>b[1]-a[1]);
 const reasonTotal=entries.reduce((sum,[,amount])=>sum+amount,0);
 const reasonRows=entries.map(([key,amount,label])=>'<div class="iv-reason"><div><span>'+label+'</span><b>'+amount.toLocaleString('zh-CN')+' 个</b></div><div class="iv-track"><i style="width:'+(reasonTotal?amount/reasonTotal*100:0)+'%"></i></div></div>').join('');
 const runTitle=repair.runId?(running?'本轮补查正在进行':'本轮补查已结束'):running?'后台正在处理代币':'当前没有补查任务';
 const runSummary=repair.runId?(n?'已处理 '+done.toLocaleString('zh-CN')+' / '+n.toLocaleString('zh-CN')+' 项 · 剩余 '+remaining.toLocaleString('zh-CN')+' 项':'正在准备查询队列'):running?'有 '+(Number(repair.health?.running)||0).toLocaleString('zh-CN')+' 项正在处理':'点击页面上方按钮，可手动补查暂时算不出的代币';
 const phaseLabels={metadata:'补充代币资料',baseline:'补上喊单时价格',ath:'查询喊单后高点'};
 const phaseLabel=phaseLabels[repair.phase]||'';
 const runFoot=repair.runId?'结果会边查边保存。已取得高点 '+(Number(repair.obtainedPeak)||0)+' 项 · 等待重试 '+(Number(repair.retryingItems)||0)+' 项 · 暂无有效行情 '+(Number(repair.noDataItems)||0)+' 项。': '暂时算不出不代表代币无效；查询失败会按规则重试，仍缺数据可手动补查。';
 host.innerHTML=`
  <section class="card iv-simple-result" aria-labelledby="iv-result-title">
   <div class="iv-simple-result-head">
    <div><h2 id="iv-result-title">喊单后最高倍数</h2><div class="iv-simple-total"><strong>${ready.toLocaleString('zh-CN')}</strong><span>个代币已算出结果</span></div></div>
    <div class="iv-simple-percent"><strong>${available}<small>%</small></strong><span>已算出</span></div>
   </div>
   <progress class="iv-simple-coverage" max="${Math.max(1,total)}" value="${Math.min(ready,total)}" aria-label="已算出 ${ready} / ${total} 个代币"></progress>
   <div class="iv-simple-breakdown"><span><i class="iv-dot green"></i>已算出 <b>${ready.toLocaleString('zh-CN')}</b></span><span><i class="iv-dot gold"></i>暂时算不出 <b>${missing.toLocaleString('zh-CN')}</b></span><span class="iv-simple-total-label">共 ${total.toLocaleString('zh-CN')} 个代币</span></div>
   <p class="iv-simple-note">等待历史补查 ${Number(reasons?.waitingQuiet)||0} 项 · 等待重试 ${Number(reasons?.retrying)||0} 项 · 平台暂无K线 ${Number(reasons?.noData)||0} 项。${Number(reasons?.observed)||0} 个待补代币已有暂估高点；暂估值不计入正式排名。已确认高点之后每天分批补查新增行情。</p>
  </section>
  <section class="card iv-query-simple" aria-labelledby="iv-query-title">
   <div class="iv-query-simple-head"><div><h2 id="iv-query-title">本轮补查</h2><p>${runTitle}${phaseLabel&&running?' · 当前：'+phaseLabel:''}</p></div><strong class="iv-query-simple-pct">${repair.runId?percent+'%':running?'处理中':'空闲'}</strong></div>
   <div class="iv-query-simple-summary">${runSummary}</div>
   ${(repair.runId||running)?'<progress class="iv-query-simple-progress" '+(repair.runId?'max="'+Math.max(1,n)+'" value="'+done+'"':'')+' aria-label="本轮补查进度"></progress>':''}
   <p class="iv-query-simple-foot" id="di-status">${runFoot}</p>
  </section>
  <details class="card iv-simple-details"><summary>查看暂时算不出的原因 <b>${missing.toLocaleString('zh-CN')} 个</b></summary><div class="iv-simple-detail-body">${reasonRows||'<p class="dim">目前没有记录到未取得原因。</p>'}<div class="iv-missing"><span>缺喊单时价格 <b>${noBase.toLocaleString('zh-CN')}</b></span><span>缺喊单后最高价 <b>${noPeak.toLocaleString('zh-CN')}</b></span></div></div></details>`;
 const retryCandidates=candidates.filter(c=>c.queue==='retry'),reviewCandidates=candidates.filter(c=>c.queue!=='retry');
 if(retryCandidates.length){const rowsHtml=retryCandidates.map(c=>'<tr><td>'+inventoryEscape(c.source==='telegram'?'Telegram':'微信')+' · '+inventoryEscape(c.channel)+'</td><td>'+inventoryEscape(c.sender)+'</td><td><code>'+inventoryEscape(c.address)+'</code><small>'+(c.chain==='?'?'链待确认':inventoryEscape(c.chain))+'</small></td><td><span class="iv-candidate-status">'+inventoryEscape(c.status)+'</span><small>'+inventoryEscape(c.reason)+'</small><small>'+(Number(c.retryAt)>0?'下次复核：'+new Date(Number(c.retryAt)*1000).toLocaleString('zh-CN'):'将自动安排复核')+'</small></td></tr>').join('');host.insertAdjacentHTML('beforeend','<details class="card iv-candidates"><summary>临时故障 · 自动重试 <b>'+retryCandidates.length.toLocaleString('zh-CN')+'</b><span>AVE、Dex 或链上查询暂时失败；系统会逐步延长间隔自动重试，不会按钱包归档。</span></summary><div class="iv-candidate-scroll"><table><thead><tr><th>来源 / 群</th><th>喊单人</th><th>地址</th><th>处理状态</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></div></details>');}
 if(reviewCandidates.length){const rowsHtml=reviewCandidates.map(c=>'<tr><td>'+inventoryEscape(c.source==='telegram'?'Telegram':'微信')+' · '+inventoryEscape(c.channel)+'</td><td>'+inventoryEscape(c.sender)+'</td><td>'+new Date(Number(c.at)*1000).toLocaleString('zh-CN')+'</td><td><code>'+inventoryEscape(c.address)+'</code><small>'+(c.chain==='?'?'链待确认':inventoryEscape(c.chain))+'</small></td><td><span class="iv-candidate-status">'+inventoryEscape(c.status)+'</span><small>'+inventoryEscape(c.reason)+'</small><button class="ghost iv-mark-wallet" type="button" data-address="'+inventoryEscape(c.address)+'">确认为钱包并移出</button></td></tr>').join('');host.insertAdjacentHTML('beforeend','<details class="card iv-candidates"><summary>待确认地址 <b>'+reviewCandidates.length.toLocaleString('zh-CN')+'</b><span>后台核查 AVE、Dex 和链上证据；无代币命中的疑似钱包会移至下方可恢复归档，不等同于确认钱包。</span></summary><div class="iv-candidate-scroll"><table><thead><tr><th>来源 / 群</th><th>喊单人</th><th>首次喊单</th><th>地址</th><th>确认状态</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></div></details>');host.querySelectorAll('.iv-mark-wallet').forEach(button=>button.onclick=async()=>{const address=button.dataset.address;if(!confirm('确认 '+address+' 是普通钱包地址？确认后会从待确认列表移出，不计为代币；可在下方恢复。'))return;button.disabled=true;try{await api('/api/address-candidates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address,confirmWallet:true})});inventorySignature='';await loadMarketAudit();}catch{button.disabled=false;button.textContent='操作失败，请重试';}});}
 if(ignored.length){const rowsHtml=ignored.map(c=>'<tr><td><code>'+inventoryEscape(c.address)+'</code></td><td>'+inventoryEscape(c.source==='telegram'?'Telegram':'微信')+' · '+inventoryEscape(c.channel)+'</td><td>'+inventoryEscape(c.sender)+'<small>'+inventoryEscape(c.disposition==='unlisted'?'无代币命中 · 疑似钱包（未证实）':c.disposition==='automatic'?'自动复核确认钱包':'手动确认为钱包')+'</small>'+(c.reason?'<small>'+inventoryEscape(c.reason)+'</small>':'')+'</td><td><button class="ghost iv-restore-wallet" type="button" data-address="'+inventoryEscape(c.address)+'">恢复核对</button></td></tr>').join('');host.insertAdjacentHTML('beforeend','<details class="card iv-candidates"><summary>已移出待确认 <b>'+ignored.length.toLocaleString('zh-CN')+'</b></summary><div class="iv-candidate-scroll"><table><thead><tr><th>地址</th><th>来源 / 群</th><th>喊单人 / 处理结果</th><th>操作</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></div></details>');host.querySelectorAll('.iv-restore-wallet').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await api('/api/address-candidates/restore-wallet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:button.dataset.address})});inventorySignature='';await loadMarketAudit();}catch{button.disabled=false;button.textContent='恢复失败，请重试';}});}
}
const inventoryAuxReader=createRepairProgressReader(()=>Promise.all([
 api('/api/acquisition-summary'),api('/api/address-candidates'),api('/api/address-candidates/ignored'),
]),Date.now,10000);
let inventoryPending,inventoryRefreshQueued=false,inventoryLastRunning=false;
loadMarketAudit=function({force=true}={}){
 if(inventoryPending){if(force)inventoryRefreshQueued=true;return inventoryPending;}
 marketAuditLoading=true;
 inventoryPending=(async()=>{
  do{
   inventoryRefreshQueued=false;
   try{
    const repair=await repairProgressReader.read();
    if(force||(inventoryLastRunning&&!repair.running))inventoryAuxReader.invalidate();
    inventoryLastRunning=!!repair.running;
    const [reasons,candidates,ignored]=await inventoryAuxReader.read();
    const signature=JSON.stringify([repair,reasons,candidates,ignored]);
    if(signature!==inventorySignature){
     const openDetails=[...document.querySelectorAll('#data-inventory details[open]')].map(el=>el.className);
     inventorySignature=signature;renderInventorySummary(repair,reasons,candidates,ignored);
     document.querySelectorAll('#data-inventory details').forEach(el=>{el.open=openDetails.includes(el.className);});
    }
    const run=document.getElementById('ma-run');
    if(run){
     run.disabled=!!repair.running;run.textContent=repair.running?'正在查询…':'查询暂时算不出的代币';
     let stop=document.getElementById('ma-stop');
     if(!stop){
      stop=document.createElement('button');stop.id='ma-stop';stop.className='ghost';stop.textContent='停止本轮';run.after(stop);
      stop.onclick=async()=>{
       stop.disabled=true;
       try{await api('/api/market-data/repair/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});inventorySignature='';await loadMarketAudit();}
       catch{stop.textContent='停止失败，请重试';}finally{stop.disabled=false;}
      };
     }
     stop.hidden=!repair.running;
    }
   }catch{
    const el=document.getElementById('di-status');if(el)el.textContent='暂时无法读取进度，已保留上次结果；可导出日志。';
   }
   force=inventoryRefreshQueued;
  }while(inventoryRefreshQueued);
 })().finally(()=>{marketAuditLoading=false;inventoryPending=undefined;});
 return inventoryPending;
};
document.addEventListener('DOMContentLoaded',()=>loadMarketAudit());
