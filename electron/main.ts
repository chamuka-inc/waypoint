import { app, BrowserWindow, ipcMain, safeStorage, shell, Notification } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { CareerService, dispatch } from '../server/service.js';
import { safeURL } from '../server/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
let service: CareerService;
let window: BrowserWindow | null = null;
let volatileKey = '';
let scheduleTimer: ReturnType<typeof setInterval> | undefined;
let scheduledRunActive = false;
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
    const showWindow = () => { window?.show(); window?.focus(); };
    const notifyNewMatches = (count: number) => {
      if (!count || !Notification.isSupported()) return;
      const notification = new Notification({ title: 'New Waypoint matches', body: count === 1 ? '1 new opportunity matches your profile.' : `${count} new opportunities match your profile.` });
      notification.on('click', showWindow); notification.show();
    };
    const checkSchedule = async () => {
      if (scheduledRunActive) return;
      const before = new Set(service.state.roles.map(role => role.id));
      try {
        if (!await service.startScheduledResearch()) return;
        scheduledRunActive = true;
        const runId = service.state.runs[0]?.id;
        while (service.state.runs.find(run => run.id === runId)?.status === 'running') await new Promise(resolve => setTimeout(resolve, 2000));
        const run = service.state.runs.find(item => item.id === runId);
        if (run?.status === 'completed') notifyNewMatches(service.state.roles.filter(role => !before.has(role.id)).length);
      } catch (error) { console.error('Scheduled research failed:', (error as Error).message); }
      finally { scheduledRunActive = false; }
    };
    scheduleTimer = setInterval(() => { void checkSchedule(); }, 60_000);
    setTimeout(() => { void checkSchedule(); }, 1500);
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
  app.on('before-quit', () => { if (scheduleTimer) clearInterval(scheduleTimer); void service?.shutdown(); });
}
