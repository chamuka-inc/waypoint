import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { CareerService } from './service.js';
import { PreviewWorkspaceManager } from './workspace-manager.js';
import { checkForUpdates } from './updates.js';

export async function createPreview(options: { directory?: string; port?: number; service?: CareerService; vite?: boolean } = {}) {
  const service = options.service || await new CareerService(options.directory || process.env.WAYPOINT_DATA_DIR || resolve('.local-data')).init();
  const manager = await new PreviewWorkspaceManager(service.directory, service).init();
  const vite = options.vite === false ? undefined : await (await import('vite')).createServer({ server: { middlewareMode: true }, appType: 'spa' });
  const server = createServer(async (req, res) => {
    const host = req.headers.host;
    const expectedHost = `127.0.0.1:${(server.address() as { port: number })?.port}`;
    if (host !== expectedHost && host !== expectedHost.replace('127.0.0.1', 'localhost')) { res.writeHead(403); res.end('Invalid host'); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.url === '/api/action') {
      // JSON custom header + strict origin/host checks prevent drive-by local agent calls.
      if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json' || req.headers['x-waypoint-client'] !== 'desktop-preview' || req.headers.origin !== `http://${host}`) { res.writeHead(403); res.end('Origin rejected'); return; }
      let body = '';
      try {
        for await (const chunk of req) { body += chunk; if (body.length > 12_000_000) throw new Error('Request too large.'); }
        const { method, args } = JSON.parse(body);
        const result = method === 'checkForUpdates' ? await checkForUpdates() : await manager.dispatch(method, args);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ result }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (e as Error).message })); }
      return;
    }
    if (vite) vite.middlewares(req, res, () => { res.writeHead(404); res.end(); });
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(options.port ?? Number(process.env.PORT || 4173), '127.0.0.1', resolve));
  return { server, service, manager, close: async () => { await manager.shutdown(); await vite?.close(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } };
}
if (process.argv[1]?.endsWith('preview.ts') || process.argv[1]?.endsWith('preview.js')) {
  const preview = await createPreview();
  console.log(`Waypoint preview: http://127.0.0.1:${(preview.server.address() as { port: number }).port}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void preview.close().then(() => process.exit(0)); });
}
