const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("xray", {
  onOverlayMode: (callback) => {const listener=(_event,value)=>callback(value);ipcRenderer.on('overlay:mode',listener);return()=>ipcRenderer.removeListener('overlay:mode',listener);},
  openDashboard: (page) => ipcRenderer.invoke("dashboard", page),
  openUrl: (url) => ipcRenderer.invoke('open-url',url),
  openGmgnChrome: (url) => ipcRenderer.invoke('open-gmgn-chrome',url),
  wakeOverlayForUrgent: () => ipcRenderer.invoke('wake-overlay-for-urgent'),
  setCollapsed: (value) => ipcRenderer.invoke('overlay-collapsed',value),
  beginDrag: () => ipcRenderer.send('overlay-drag-start'),
  moveDrag: () => ipcRenderer.send('overlay-drag-move'),
  endDrag: () => ipcRenderer.send('overlay-drag-end'),
  setOpacity: (value) => ipcRenderer.invoke("opacity", value),
  hideOverlay: () => ipcRenderer.invoke("hide-overlay"),
});
