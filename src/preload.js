const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onPortList: (handler) => {
    const listener = (_event, ports) => handler(ports);
    ipcRenderer.on('serial:port-list', listener);
    return () => ipcRenderer.removeListener('serial:port-list', listener);
  },
  selectPort: (portId) => ipcRenderer.send('serial:select-port', portId),
});
