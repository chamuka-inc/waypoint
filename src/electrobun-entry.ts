import { Electroview } from 'electrobun/view';
import type { WaypointRPC } from './desktop-rpc.js';

const rpc = Electroview.defineRPC<WaypointRPC>({
  maxRequestTime: 60_000,
  handlers: { requests: {}, messages: {} },
});
const view = new Electroview({ rpc });

window.addEventListener('waypoint-ready', () => {
  view.rpc!.send.ready({ title: document.title });
}, { once: true });

window.waypoint = {
  call: (method: string, ...args: unknown[]) => view.rpc!.request.action({ method, args }),
};

document.addEventListener('click', event => {
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[target="_blank"]');
  if (!link) return;
  event.preventDefault();
  void view.rpc!.request.openExternal({ url: link.href });
});

await import('./app.js');
