const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {getEventListeners}=require('node:events');
test('completed or failed AVE searches release deadline timers and abort listeners',async()=>{
  const timers=new Set(),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/request-deadline.cjs'),'utf8'),{
    module,Promise,Error,setTimeout(fn){const timer={fn,unref(){}};timers.add(timer);return timer;},clearTimeout(timer){timers.delete(timer);},
  });
  const {withRequestDeadline}=module.exports,controller=new AbortController();
  for(let i=0;i<100;i++)assert.equal(await withRequestDeadline(Promise.resolve(i),{signal:controller.signal}),i);
  await assert.rejects(withRequestDeadline(Promise.reject(Error('failed')),{signal:controller.signal}),/failed/);
  assert.equal(timers.size,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);
  const pending=withRequestDeadline(new Promise(()=>{}),{signal:controller.signal});controller.abort(Error('cancelled'));
  await assert.rejects(pending,/cancelled/);assert.equal(timers.size,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
