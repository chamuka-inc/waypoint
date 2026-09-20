export type WaypointRPC = {
  bun: {
    requests: {
      action: {
        params: { method: string; args: unknown[] };
        response: unknown;
      };
      openExternal: {
        params: { url: string };
        response: boolean;
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      ready: { title: string };
    };
  };
};
