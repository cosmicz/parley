// Vite serves the phone app (index.html), the projector page (companion.html)
// and the Parley API (server/api.ts) from one origin, so the phone reaches
// everything by LAN address or tunnel. Keys come from loadEnv with no prefix
// filter: they are visible to this config only, never to the client bundle,
// which sees VITE_-prefixed variables alone.

import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { createApi } from './server/api.ts';
import { readConfig } from './server/config.ts';
import { EventHub } from './server/events.ts';

function parleyApi(env: Record<string, string>): Plugin {
  const config = readConfig(env);
  const hub = new EventHub();
  const api = createApi({ config, hub });
  return {
    name: 'parley-api',
    configureServer(server) {
      server.middlewares.use(api);
      server.httpServer?.once('close', () => hub.close());
    },
    configurePreviewServer(server) {
      server.middlewares.use(api);
      server.httpServer?.once('close', () => hub.close());
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [parleyApi(loadEnv(mode, process.cwd(), ''))],
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  build: {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        companion: fileURLToPath(new URL('./companion.html', import.meta.url)),
      },
    },
  },
}));
