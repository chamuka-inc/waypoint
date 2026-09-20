import Electrobun, { BrowserView, BrowserWindow, Utils, type RPCSchema } from 'electrobun/main';
import { CareerService, dispatch } from '../server/service.js';
import { safeURL } from '../server/schema.js';
import type { WaypointRPC } from '../src/desktop-rpc.js';

let sessionKey = '';
let scheduledRunActive = false;
let quitting = false;
const service = await new CareerService(Utils.paths.userData, true, undefined, {
  read: () => sessionKey,
  write: key => { sessionKey = key; },
}).init();

const rpc = BrowserView.defineRPC<{
  bun: RPCSchema<WaypointRPC['bun']>;
  webview: RPCSchema<WaypointRPC['webview']>;
}>({
  maxRequestTime: 60_000,
  handlers: {
    requests: {
      action: ({ method, args }) => dispatch(service, method, args),
      openExternal: ({ url }) => {
        const safe = safeURL(url);
        return safe ? Utils.openExternal(safe) : false;
      },
    },
    messages: {},
  },
});

const mainWindow = new BrowserWindow({
  title: 'Waypoint',
  url: 'views://mainview/index.html',
  rpc,
  frame: { width: 1460, height: 980 },
  renderer: 'native',
});
mainWindow.webview.setNavigationRules(['views://mainview/*']);

const checkSchedule = async () => {
  if (scheduledRunActive) return;
  const before = new Set(service.state.roles.map(role => role.id));
  try {
    if (!await service.startScheduledResearch()) return;
    scheduledRunActive = true;
    const runId = service.state.runs[0]?.id;
    while (service.state.runs.find(run => run.id === runId)?.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const run = service.state.runs.find(item => item.id === runId);
    if (run?.status !== 'completed') return;
    const count = service.state.roles.filter(role => !before.has(role.id)).length;
    if (count) Utils.showNotification({
      title: 'New Waypoint matches',
      body: count === 1 ? '1 new opportunity matches your profile.' : `${count} new opportunities match your profile.`,
    });
  } catch (error) {
    console.error('Scheduled research failed:', (error as Error).message);
  } finally {
    scheduledRunActive = false;
  }
};

const scheduleTimer = setInterval(() => { void checkSchedule(); }, 60_000);
setTimeout(() => { void checkSchedule(); }, 1500);

Electrobun.events.on('reopen', () => mainWindow.show());
Electrobun.events.on('before-quit', event => {
  if (quitting) return;
  event.response = { allow: false };
  clearInterval(scheduleTimer);
  void service.shutdown().finally(() => {
    quitting = true;
    Utils.quit(0);
  });
});
