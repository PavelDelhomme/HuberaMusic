const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
/** Canonique prod — alias ytmusic.delhomme.ovh reste OK via NPM. */
const PROD_URL = process.env.PLM_URL || process.env.YTM_PROD_URL || 'https://plm.delhomme.ovh';
const DEV_URL = process.env.YTM_DEV_URL || 'http://localhost:5173';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#030303',
    title: 'PLM',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Dev : Vite local. Packagé : PWA prod (toujours à jour côté UI — pas de second runtime audio).
  const url = isDev ? DEV_URL : PROD_URL;
  win.loadURL(url);
  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    shell.openExternal(openUrl);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
