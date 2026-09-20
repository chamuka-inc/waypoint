import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { CareerService, dispatch } from '../server/service.js';
import { safeURL } from '../server/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
let service: CareerService;
let window: BrowserWindow | null = null;
let volatileKey = '';
const indexPath = join(here, '../../dist/index.html');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    const data = app.getPath('userData');
    const keyPath = join(data, 'typesafe-key.enc');
    service = await new CareerService(data, true, undefined, {
      read: () => { if (volatileKey) return volatileKey; try { return existsSync(keyPath) && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(readFileSync(keyPath)) : ''; } catch { return ''; } },
      write: (key) => {
        if (!key) { volatileKey = ''; if (existsSync(keyPath)) unlinkSync(keyPath); return; }
        if (safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')) { writeFileSync(keyPath, safeStorage.encryptString(key), { mode: 0o600 }); volatileKey = ''; }
        else volatileKey = key;
      },
    }).init();
    ipcMain.handle('waypoint:action', async (event, method: string, args: unknown[]) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted sender.');
      return dispatch(service, method, args);
    });
    const openWindow = () => {
      window = new BrowserWindow({ width: 1460, height: 980, minWidth: 1024, minHeight: 700, title: 'Waypoint', backgroundColor: '#f7f8f5', autoHideMenuBar: true, webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
      window.webContents.setWindowOpenHandler(({ url }) => { const safe = safeURL(url); if (safe) void shell.openExternal(safe); return { action: 'deny' }; });
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'"] } }));
      void window.loadFile(indexPath);
      window.on('closed', () => { window = null; });
    };
    openWindow();
    app.on('activate', () => { if (!window) openWindow(); });
  }).catch(error => { console.error('Waypoint startup failed:', error.message); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { void service?.shutdown(); });
}
