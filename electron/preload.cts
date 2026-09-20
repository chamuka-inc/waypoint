const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('waypoint', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('waypoint:action', method, args),
});
