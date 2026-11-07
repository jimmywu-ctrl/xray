import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../src/ui/overlay.js',import.meta.url),'utf8');
function section(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
class List {
  constructor(height=210){this.childNodes=[];this.clientHeight=height;this.scrollTop=0;this.moves=0;this.removes=0;}
  get lastChild(){return this.childNodes.at(-1);}
  insertBefore(node,before){const old=this.childNodes.indexOf(node);if(old>=0)this.childNodes.splice(old,1);const index=before?this.childNodes.indexOf(before):this.childNodes.length;this.childNodes.splice(index,0,node);this.moves++;}
  removeChild(node){this.childNodes.splice(this.childNodes.indexOf(node),1);this.removes++;}
}
function fixture(count=5,height=210){
  const list=new List(height),stats={build:0,quote:0},tokens=Array.from({length:count},(_,i)=>({key:'sol:'+i,chain:'sol',address:String(i),symbol:'coin'+i,callers:['caller'],mentions:[{time:100}],price:1}));
  const context=vm.createContext({state:{visibleTokens:tokens,callerLabels:{},now:100},els:{list},VIRTUAL_ROW_HEIGHT:70,VIRTUAL_OVERSCAN:0,
    reportVisibleTokens(){},reportVisibleLatencyTraces(){},pickTokenKey:t=>t.key,pickAddr:t=>t.address,pickChain:t=>t.chain,pickResolved:()=>true,pickSymbol:t=>t.symbol,pickLogo:t=>t.logo,pickCallers:t=>t.callers,callerLabelOf:()=>'',pickChannelSources:()=>[],pickKol:()=>1,
    $:()=>({style:{},setAttribute(){}}),buildRow:t=>{stats.build++;return {key:t.key,_token:t};},updateRowQuote:(node,t)=>{stats.quote++;node._token=t;},
  });
  vm.runInContext(section('  var rowNodes = new Map();','  function reportVisibleTokens()'),context);
  vm.runInContext(section('  function renderVisibleRows(force)','  function renderList()'),context);
  return {context,list,stats,tokens};
}
test('one quote among 200 visible cards updates one card without recreating or moving DOM',()=>{
  const {context:c,list,stats,tokens}=fixture(200,14000);c.renderVisibleRows(true);assert.equal(stats.build,200);
  const nodes=[...list.childNodes],moves=list.moves;
  c.renderVisibleRows(true);assert.equal(stats.build,200);assert.equal(stats.quote,0);assert.equal(list.moves,moves);
  c.state.visibleTokens=tokens.map((t,i)=>i===50?{...t,price:2}:t);c.renderVisibleRows(true);
  assert.equal(stats.build,200);assert.equal(stats.quote,1);assert.equal(list.moves,moves);assert.ok(nodes.every((n,i)=>n===list.childNodes[i]));assert.equal(list.childNodes[50]._token.price,2);
});
test('metadata replacement, order changes and virtual scrolling preserve correct rows and bounded cache',()=>{
  const {context:c,list,stats,tokens}=fixture();c.renderVisibleRows(true);const first=list.childNodes[0];
  c.state.visibleTokens=[{...tokens[0],symbol:'renamed'},...tokens.slice(1)];c.renderVisibleRows(true);assert.notEqual(list.childNodes[0],first);assert.equal(stats.build,4);
  const second=list.childNodes[1];c.state.visibleTokens=[tokens[1],tokens[0],...tokens.slice(2)];c.renderVisibleRows(true);assert.equal(list.childNodes[0],second);
  list.scrollTop=140;c.renderVisibleRows(false);assert.ok(c.rowNodes.size<=3);assert.equal(list.childNodes[0].style.height,'140px');assert.ok(c.rowNodes.has(tokens[4].key));
  c.state.visibleTokens=[];c.renderVisibleRows(true);assert.equal(c.rowNodes.size,0);assert.equal(list.childNodes.length,0);assert.equal(list.scrollTop,0);
});
test('reused quote cells transition between gains, missing baselines and stale quotes correctly',()=>{
  const nodes={mc:{className:''},mcText:{nodeValue:''},stale:{hidden:true},change:{textContent:'',className:'',title:''},right:{title:''},correct:{title:''}};
  const row={_quoteNodes:nodes};
  const c=vm.createContext({state:{now:100},pickCallBaseline:t=>({marketCap:t.baseline,time:50}),pickFirstSeen:()=>50,pickMc:t=>t.mc,pickMarket:t=>t.market,fmtCompact:x=>x==null?'—':String(x),exactTimeTitle:String,fmtAgoShort:(at,now)=>String(now-at)});
  vm.runInContext(section('  function setRowText(','  function filteredTokens()'),c);
  const token={mc:100,baseline:50,currentMultiple:2,market:{receivedAt:100,source:'dex'}};c.updateRowQuote(row,token);assert.equal(nodes.mcText.nodeValue,'100');assert.equal(nodes.change.textContent,'↑ 100.0%');assert.equal(nodes.change.className,'chg up');assert.equal(nodes.stale.hidden,true);
  c.state.now=140;const pending={...token,currentMultiple:null,baseline:null,changePendingReason:'missing'};c.updateRowQuote(row,pending);assert.equal(row._token,pending);assert.equal(nodes.change.className,'chg');assert.match(nodes.change.title,/missing/);assert.equal(nodes.stale.hidden,false);
  c.updateRowQuote(row,{...token,currentMultiple:0.5,market:{receivedAt:140,source:'dex'}});assert.equal(nodes.change.className,'chg down');assert.equal(nodes.change.textContent,'↓ 50.0%');assert.equal(nodes.stale.hidden,true);assert.doesNotMatch(nodes.change.title,/missing/);
});
