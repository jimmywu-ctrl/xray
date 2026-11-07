// Presentation APIs for the cloned UI; every operation targets the new backend.
(() => {
  const request=async(p,body,signal)=>{const r=await fetch(p,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000),...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw Error(data.error||'请求失败');return data;};
  const listeners={state:[],status:[],labels:[],backfill:[],mode:[]};
  const subscribe=(type,callback)=>{listeners[type].push(callback);return()=>listeners[type]=listeners[type].filter(c=>c!==callback);};
  const lastEmitted={};const emit=(type,data)=>{if(type==='status')lastEmitted.status=data;listeners[type].forEach(cb=>cb(data));};
  let current, polling=false, refreshPending=false, collapsed=false, lastLabels='', lastStatus='';
  let refreshController, refreshProtected=false;
  let tokenRevision=0,tokenEpoch='';const tokenCache=new Map();
  const inactive=()=>document.hidden||(location.pathname==='/overlay'&&collapsed);
  const auxiliary=Object.fromEntries(['snapshot','health','backfill','labels'].map(name=>[name,{busy:false,last:0}]));
  const invalidateAuxiliary=()=>{for(const slot of Object.values(auxiliary))slot.last=0;};
  window.xray?.onOverlayMode(value=>{collapsed=value;emit('mode',value);if(!value){invalidateAuxiliary();void refresh();}});
  function emitConnected(){
    const monitor=current?.settings?.monitor||{wechat:[],telegram:[]};
    const telegram=current?.monitor?.telegram;
    const wechat=current?.monitor?.wechat||{};
    const telegramReady=!monitor.telegram.length||telegram?.state==='connected';
    const wechatReady=!monitor.wechat.length||Number(wechat.ready??wechat.watched??0)>=monitor.wechat.length;
    const link=telegramReady&&wechatReady?'connected':'reconnecting';
    const status={link,groups:[...monitor.wechat,...monitor.telegram.map(g=>g.title)],sourcesConfigured:!!(monitor.wechat.length+monitor.telegram.length),sources:{wechat:{selected:monitor.wechat.length,ready:Number(wechat.ready??wechat.watched??0)},telegram:{selected:monitor.telegram.length,ready:telegramReady?monitor.telegram.length:0,state:telegram?.state??'not_configured'}},dashboardUrl:true};
    const statusKey=JSON.stringify(status);if(statusKey!==lastStatus){lastStatus=statusKey;emit('status',status);}
  }
  function runAuxiliary(name,task){
    const slot=auxiliary[name];if(slot.busy||Date.now()-slot.last<10000)return;
    slot.busy=true;slot.last=Date.now();
    void Promise.resolve().then(task).catch(()=>{}).finally(()=>{slot.busy=false;});
  }
  function refreshAuxiliary(){
    if(inactive())return;
    // Separate locks: a slow health, settings or label request never owns the
    // real-time delta lock, and each auxiliary request has at most one flight.
    runAuxiliary('snapshot',async()=>{
      current=await request(location.pathname==='/overlay'?'/api/overlay-state':'/api/summary-state');
      window.dispatchEvent(new CustomEvent('xray:snapshot',{detail:current}));
      emitConnected();
      if(location.pathname==='/overlay')window.xray?.setOpacity(current.settings.opacity);
    });
    runAuxiliary('health',async()=>{
    try{const h=await request('/api/task-health'),alert=['stalled','rate-limited','timeout','failed'].includes(h.state),el=document.getElementById('task-health');
      window.dispatchEvent(new CustomEvent('xray:health',{detail:h}));
      const detail=`${h.label} · 处理中 ${h.running} · 排队 ${h.queued} · 等待重试 ${h.backoff}`+(h.completed10m!=null?` · 10分钟完成 ${h.completed10m}`:'')+(h.scheduled?` · 已排期 ${h.scheduled}`:'');
      if(el){el.hidden=!alert||(h.state==='failed'&&!h.pending);el.textContent=detail+(h.reason?' · '+h.reason:'')+(h.waitSeconds?' · 最近任务约 '+h.waitSeconds+' 秒后重试':'');el.style.color=alert?'#e2b767':'#8d979b';el.title='实时行情与后台补齐独立运行；可在数据补齐页导出日志';}
      // Overlay footer reflects its live connection, never completed acquisition failures.
      if(location.pathname!=='/overlay'){const foot=document.getElementById('ft-link');if(foot){foot.title=detail+(h.reason?'：'+h.reason:'');if(alert&&h.pending)foot.textContent=h.state==='rate-limited'?'查询限流':h.state==='timeout'?'查询超时':'查询无进展';}}
    }catch{const el=document.getElementById('task-health');if(el){el.hidden=false;el.textContent='后台任务状态查询超时，正在重试；请在数据补齐页导出日志。';}}
    });
    if(listeners.backfill.length)runAuxiliary('backfill',async()=>emit('backfill',await request('/api/backfill/status')));
    if(listeners.labels.length)runAuxiliary('labels',async()=>{const labels=await request('/api/caller-labels');const s=JSON.stringify(labels);if(s!==lastLabels){lastLabels=s;emit('labels',labels);}});
  }
  async function refresh(urgent=false,protect=false){if(inactive())return;if(polling){refreshPending=true;if(urgent&&!refreshProtected)refreshController?.abort();return;}polling=true;refreshProtected=urgent||protect;const controller=refreshController=new AbortController();try{
    if(listeners.state.length){
      const delta=await request('/api/token-updates?since='+tokenRevision+'&epoch='+encodeURIComponent(tokenEpoch),undefined,controller.signal);
      if(controller.signal.aborted)return;
      if(delta.reset)tokenCache.clear();
      for(const key of delta.removed)tokenCache.delete(key);
      for(const token of delta.changed)tokenCache.set(token.key||token.chain+':'+token.address,token);
      tokenRevision=delta.revision;
      tokenEpoch=delta.epoch||'';
      if(delta.reset||delta.changed.length||delta.removed.length)emit('state',[...tokenCache.values()]);
    }
    emitConnected();
  }catch{if(!controller.signal.aborted){lastStatus='';emit('status',{link:'disconnected'});}}finally{polling=false;refreshController=null;refreshProtected=false;refreshAuxiliary();if(refreshPending){refreshPending=false;void refresh(false,true);}}}
  const openDashboard=page=>window.xray?.openDashboard(page)??location.assign('/'+(page?'?page='+encodeURIComponent(page):''));
  const labels={getCallerLabels:()=>request('/api/caller-labels'),setCallerLabel:async(raw,label)=>{const map=await request('/api/caller-labels',{raw,label});emit('labels',map);return {ok:true,labels:map};},onCallerLabels:cb=>subscribe('labels',cb)};
  window.fomomoDashboard={...labels,showOverlay:()=>request('/api/desktop',{action:'overlay'}),openAveLogin:()=>request('/api/site',{provider:'ave'}),runBackfill:(source,duration,resume)=>request('/api/backfill/run',{source,duration,resume}),getBackfillStatus:()=>request('/api/backfill/status'),onBackfillStatus:cb=>subscribe('backfill',cb),reportOverlayLogoFailure:(chain,address,logo)=>request('/api/overlay/logo-failed',{chain,address,logo})};
  window.fomomo={...labels,correctCa:async body=>{const result=await request("/api/ca-correction",body);void refresh();return result;},onState:cb=>{const off=subscribe('state',cb);void refresh();return off;},reportReceivedCalls:entries=>request('/api/debug/message-latency/received',{entries}),reportRenderedCalls:(traceIds,displayedAtMs)=>request('/api/debug/message-latency/rendered',{traceIds,displayedAtMs}),onStatus:cb=>{const off=subscribe('status',cb);if(lastEmitted.status)cb(lastEmitted.status);return off;},onOverlayMode:cb=>subscribe('mode',cb),getMonitorMutes:async()=>({ok:true,mutes:await request('/api/monitor-mutes')}),setMonitorMuted:async token=>({ok:true,mutes:await request('/api/monitor-mutes',token)}),setStatsExcluded:token=>request('/api/stats/exclusions',token),setVisibleTokens:tokens=>request('/api/visible',{keys:tokens.map(t=>t.key||t.chain+':'+t.address)}),focusToken:()=>{},queryAveDetails:(chain,address)=>request('/api/quote-details',{chain,address,provider:'ave'}),openDashboard,openTokenGmgn:(chain,address)=>{const route=String(chain||'').trim().toLowerCase(),ca=String(address||'').trim();if(!ca)return;const open=url=>window.xray?.openGmgnChrome?window.xray.openGmgnChrome(url):window.open(url,'_blank');if(!route||route==='?'){let copied=false;const copy=navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(ca).then(()=>{copied=true;}).catch(()=>{}):Promise.resolve();return copy.then(()=>open('https://gmgn.ai/')).then(()=>({fallback:true,copied}));}const url='https://gmgn.ai/'+encodeURIComponent(route)+'/token/'+encodeURIComponent(ca);return open(url);},collapse:()=>{collapsed=true;emit('mode',true);window.xray?.setCollapsed(true);},expand:()=>{collapsed=false;emit('mode',false);window.xray?.setCollapsed(false);},beginCollapsedDrag:()=>window.xray?.beginDrag(),moveCollapsed:()=>window.xray?.moveDrag(),endCollapsedDrag:()=>window.xray?.endDrag()};
  // Coalesce SSE bursts, with a trailing refresh so the last change is not lost.
  let lastRefreshAt=0,trailingRefresh=null;
  const overlayPage=location.pathname==='/overlay',refreshFloor=overlayPage?50:1000,refreshFallback=overlayPage?1000:2000;
  const scheduleRefresh=urgent=>{if(urgent&&overlayPage){clearTimeout(trailingRefresh);trailingRefresh=null;lastRefreshAt=Date.now();void refresh(true);return;}const wait=refreshFloor-(Date.now()-lastRefreshAt);if(wait<=0){clearTimeout(trailingRefresh);trailingRefresh=null;lastRefreshAt=Date.now();void refresh();}else if(!trailingRefresh)trailingRefresh=setTimeout(()=>{trailingRefresh=null;lastRefreshAt=Date.now();void refresh();},wait);};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){invalidateAuxiliary();void refresh();}});
  const events=new EventSource('/api/events');events.onmessage=async event=>{let urgent=false,wake=false;try{const data=JSON.parse(event.data);urgent=data.urgent===true;wake=data.wake===true;}catch{}if(wake&&overlayPage){try{await window.xray?.wakeOverlayForUrgent?.();}catch{}}scheduleRefresh(urgent);};events.onerror=()=>{lastStatus='';emit('status',{link:'reconnecting'});};events.onopen=()=>{lastStatus='';void refresh();};setInterval(scheduleRefresh,refreshFallback);void refresh();
  document.addEventListener('DOMContentLoaded',()=>{const page=new URLSearchParams(location.search).get('page');if(page&&window.showTab)window.showTab(page);});
  document.addEventListener('click',e=>{const a=e.target.closest?.('a[target="_blank"]');if(a&&window.xray?.openUrl&&a.href.startsWith('https://')){e.preventDefault();window.xray.openUrl(a.href);}});
})();
