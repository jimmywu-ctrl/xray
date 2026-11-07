import {count,setContent} from './shared.js';

export function renderStatistics(s){
  const rows=s.rows||[];
  const ready=rows.filter(r=>{const x=r.priceMultiple??r.formalMultiple;return x!=null&&Number.isFinite(Number(x));});
  const ranked=new Set(ready.map(r=>r.senderKey));
  setContent('module-statistics',
    '<section class="card module-panel stats-explainer"><div class="module-heading"><div><h2>这张榜怎么看</h2><p>按每位喊单人已算出的“喊单后最高倍数”取平均，再从高到低排序。</p></div></div>'+ 
    '<div class="stats-explainer-grid">'+
      '<div><b>'+count(ready.length)+'</b><span>条喊单已算出最高倍数</span></div>'+ 
      '<div><b>'+count(ranked.size)+'</b><span>位喊单人有可计算结果</span></div>'+ 
      '<div><b>全部</b><span>所有可计算的有效喊单都参与排名</span></div>'+ 
    '</div><p class="module-formula">单条倍数 = 喊单后的最高点 ÷ 喊单时基准。只有两项数据都取得，才会计入平均值。</p></section>');
}
