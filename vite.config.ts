import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import mapBridgePlugin from './src/bridge/vitePlugin';

export default defineConfig({
  server: {
    port: 3001,
    host: '0.0.0.0',
    allowedHosts: ['teleos'],
    https: {},
  },
  plugins: [basicSsl(), react(), mapBridgePlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
