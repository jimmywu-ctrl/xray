import {renderOverview} from './overview.js';import {renderListening} from './listening.js?v=20261013-wechat-status-counts';import {renderStatistics} from './statistics.js';import {renderSettings,groupSettings} from './settings.js';
import {acquisitionCounts} from './shared.js';
import {createVisibleModuleRenderer} from './visible-module.js';
let snapshot,health;
const activePage=()=>document.querySelector('.content>section.on')?.id;
const renderVisible=createVisibleModuleRenderer({activePage,views:{
  audit:{render:renderOverview,select:s=>[s.rows?.filter(r=>r.lastCall>=s.time-24*3600).length,acquisitionCounts(s)]},
  groups:{render:renderListening,select:s=>{const w=s.monitor?.wechat??{},t=s.monitor?.telegram??{},m=s.settings?.monitor??{};return [w.selected,w.ready,w.running,w.retrying,m.wechat?.length,t.state,t.error,m.telegram?.length];}},
  stats:{render:renderStatistics,select:s=>{const ready=(s.rows??[]).filter(r=>{const x=r.priceMultiple??r.formalMultiple;return x!=null&&Number.isFinite(Number(x));});return [ready.length,new Set(ready.map(r=>r.senderKey)).size];}},
  settings:{render:renderSettings,select:(s,h)=>[s.settings?.opacity,h]},
}});
function render(){renderVisible(snapshot,health);}
window.addEventListener('xray:snapshot',e=>{snapshot=e.detail;render();});
window.addEventListener('xray:health',e=>{health=e.detail;if(activePage()==='settings')render();});
document.addEventListener('click',e=>{const button=e.target.closest('[data-module-go]');if(button)window.showTab(button.dataset.moduleGo);});
groupSettings();
const show=window.showTab;window.showTab=(id,sub)=>{const result=show(id,sub);if(activePage()==='audit')void window.loadMarketAudit?.();render();return result;};
fetch('/api/summary-state',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)throw Error('读取失败');return r.json();}).then(s=>{if(!snapshot)snapshot=s;render();}).catch(()=>{if(snapshot)return;const ids={audit:'module-overview',groups:'module-listening',stats:'module-statistics',settings:'module-settings'};const el=document.getElementById(ids[activePage()]);if(el)el.innerHTML='<div class="card module-panel module-warning" role="status">暂时无法读取后台状态，请检查应用连接。</div>';});
