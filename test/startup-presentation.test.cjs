const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createWindowPresentation}=require('../desktop/window-presentation.cjs');
function fixture(){const window=new EventEmitter(),calls=[];window.destroyed=false;window.isDestroyed=()=>window.destroyed;for(const name of ['show','showInactive','focus','hide'])window[name]=()=>calls.push(name);return {window,calls,presentation:createWindowPresentation(window)};}
test('new windows are shown only after painting, and later requests show immediately',()=>{const {window,calls,presentation}=fixture();presentation.show({focus:true});assert.deepEqual(calls,[]);window.emit('ready-to-show');assert.deepEqual(calls,['show','focus']);presentation.show({inactive:true});assert.deepEqual(calls,['show','focus','showInactive']);});
test('hide or destruction cancels a pending first-frame display',()=>{const {window,calls,presentation}=fixture();presentation.show();presentation.hide();window.emit('ready-to-show');assert.deepEqual(calls,['hide']);window.destroyed=true;presentation.show();assert.deepEqual(calls,['hide']);});
test('repeated requests before paint keep the latest display intent without extra listeners',()=>{const {window,calls,presentation}=fixture();presentation.show();presentation.show({inactive:true});assert.equal(window.listenerCount('ready-to-show'),1);window.emit('ready-to-show');assert.deepEqual(calls,['showInactive']);});
