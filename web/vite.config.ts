import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readAppVersion(): string {
  try {
    return readFileSync(resolve(__dirname, '../VERSION'), 'utf8').trim() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function resolveChannel(mode: string): 'd' | 'p' {
  const ref = (process.env.BUILD_REF || process.env.APP_CHANNEL || '').toLowerCase()
  if (ref === 'prod' || ref === 'p' || ref === 'production') return 'p'
  if (ref === 'dev' || ref === 'd' || ref === 'local') return 'd'
  // Sans BUILD_REF : `vite build` → p+ · `vite` (dev) → d+
  return mode === 'production' ? 'p' : 'd'
}

export default defineConfig(({ mode }) => {
  const appVersion = readAppVersion()
  const channel = resolveChannel(mode)

  return {
  // Charge .env à la racine du monorepo (aligné avec l’API)
  envDir: '..',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_CHANNEL__: JSON.stringify(channel),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // Ne jamais enregistrer de SW en dev (sinon /api peut servir du HTML cache)
      devOptions: { enabled: false },
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'PLM',
        short_name: 'PLM',
        description: 'PLM — musique sans pubs, web et mobile',
        theme_color: '#030303',
        background_color: '#030303',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icon-192-maskable.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Streams audio : jamais CacheFirst (sinon un prefetch Range empoisonne la piste)
            urlPattern: ({ url }) => url.pathname.startsWith('/api/stream/'),
            handler: 'NetworkOnly',
          },
          {
            // Recherche / suggestions : jamais de cache SW
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/api/search') ||
              url.pathname.startsWith('/api/search/'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/api/') &&
              !url.pathname.startsWith('/api/stream/') &&
              !url.pathname.startsWith('/api/search'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
    }),
  ],
  // Évite les 504 "Outdated Optimize Dep" après ajout de paquets
  optimizeDeps: {
    include: [
      '@simplewebauthn/browser',
      'qrcode.react',
      'react',
      'react-dom',
      'react-router-dom',
      'zustand',
      'lucide-react',
      'idb',
    ],
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        timeout: 120_000,
        proxyTimeout: 120_000,
        configure: (proxy) => {
          let lastLog = 0;
          proxy.on('error', (err, _req, res) => {
            const now = Date.now();
            // Évite le spam ECONNREFUSED dans make logs (WS/API down)
            if (now - lastLog > 15_000) {
              lastLog = now;
              console.error('[vite-proxy /api]', err.message, '— lance make ensure-api');
            }
            if (res && 'writeHead' in res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'Bad Gateway — API indisponible sur :8787',
                  hint: 'Lance make ensure-api ou make up-full',
                }),
              );
            }
          });
        },
      },
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
        timeout: 0,
        configure: (proxy) => {
          let lastLog = 0;
          proxy.on('error', (err) => {
            const now = Date.now();
            if (now - lastLog > 15_000) {
              lastLog = now;
              console.error('[vite-proxy /ws]', err.message, '— lance make ensure-api');
            }
          });
        },
      },
    },
  },
  }
})
