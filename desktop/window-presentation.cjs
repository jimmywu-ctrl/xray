// A new native window stays hidden until Chromium has painted its first frame.
function createWindowPresentation(window) {
  let ready=false,pending=null;
  const apply=({inactive=false,focus=false})=>{
    if(window.isDestroyed())return;
    if(inactive)window.showInactive();else window.show();
    if(focus)window.focus();
  };
  window.once('ready-to-show',()=>{ready=true;const request=pending;pending=null;if(request)apply(request);});
  window.once('closed',()=>{pending=null;});
  return {
    show(request={}){if(window.isDestroyed())return;if(ready)apply(request);else pending=request;},
    hide(){pending=null;if(!window.isDestroyed())window.hide();},
  };
}
module.exports={createWindowPresentation};
