import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVisibleModuleRenderer} from '../src/ui/modules/visible-module.js';

test('hidden modules do no work and opening one renders the latest snapshot once',()=>{
  let active='overview';const calls=[],selections=[];
  const views=Object.fromEntries(['groups','settings','stats','audit'].map(page=>[page,{select:s=>{selections.push(page);return s[page];},render:s=>calls.push([page,s[page]])}]));
  const render=createVisibleModuleRenderer({activePage:()=>active,views});
  render({groups:1,stats:1});assert.deepEqual(calls,[]);assert.deepEqual(selections,[]);
  active='groups';render({groups:1,stats:1});render({groups:1,stats:2});assert.deepEqual(calls,[['groups',1]]);assert.ok(!selections.includes('stats'));
  active='stats';render({groups:1,stats:2});assert.deepEqual(calls.at(-1),['stats',2]);
  active='groups';render({groups:3,stats:2});assert.deepEqual(calls.at(-1),['groups',3]);
  active='stats';render({groups:3,stats:2});assert.equal(calls.length,3);
});
test('health and render errors cannot suppress a later active-page update',()=>{
  let fail=true,count=0;const render=createVisibleModuleRenderer({activePage:()=> 'settings',views:{settings:{select:(s,h)=>h?.state,render:()=>{if(fail){fail=false;throw Error('temporary render error');}count++;}}}});
  assert.throws(()=>render({}, {state:'connected'}));render({}, {state:'connected'});render({}, {state:'connected'});render({}, {state:'timeout'});assert.equal(count,2);
});
