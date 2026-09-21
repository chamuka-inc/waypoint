declare global {
  interface Window {
    go?: {
      main?: {
        App?: {
          Call(method: string, args: unknown[]): Promise<unknown>;
          OpenExternal(url: string): Promise<void>;
          Ready(title: string): Promise<void>;
        };
      };
    };
  }
}

export {};

const backend = window.go?.main?.App;
if (backend) {
  window.waypoint = {
    call: (method: string, ...args: unknown[]) => backend.Call(method, args),
  };

  document.addEventListener('click', event => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[target="_blank"]');
    if (!anchor) return;
    event.preventDefault();
    void backend.OpenExternal(anchor.href);
  });

  window.addEventListener('waypoint-ready', () => {
    void backend.Ready(document.title);
  }, { once: true });
}

await import('./app.js');
