const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow;
let pendingPortCallback = null;
const approvedDeviceKeys = new Set();
const portIdToDeviceKey = new Map();

const portListKey = (p) => p.deviceInstanceId || p.portName;
const deviceDetailsKey = (d) => d && (d.device_instance_id || d.bluetooth_device_path);

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const { session } = mainWindow.webContents;

  session.setPermissionCheckHandler((_wc, permission) => permission === 'serial');
  session.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'serial') return false;
    return approvedDeviceKeys.has(deviceDetailsKey(details.device));
  });

  session.on('select-serial-port', (event, portList, _wc, callback) => {
    event.preventDefault();
    portIdToDeviceKey.clear();
    for (const p of portList) {
      portIdToDeviceKey.set(p.portId, portListKey(p));
    }
    pendingPortCallback = (selectedPortId) => {
      if (selectedPortId) {
        const key = portIdToDeviceKey.get(selectedPortId);
        if (key) approvedDeviceKeys.add(key);
      }
      callback(selectedPortId || '');
    };
    mainWindow.webContents.send('serial:port-list', portList);
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.openDevTools();
};

ipcMain.on('serial:select-port', (_event, portId) => {
  if (pendingPortCallback) {
    pendingPortCallback(portId || '');
    pendingPortCallback = null;
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
