import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_SIGNALING_URL || 'http://localhost:3001';
  const useHttps = env.DEV_HTTPS === 'true';

  const rootCertDir = fs.existsSync(path.resolve(process.cwd(), '.certs'))
    ? path.resolve(process.cwd(), '.certs')
    : path.resolve(process.cwd(), '..', '.certs');

  return {
    plugins: [react()],
    server: {
      https: useHttps
        ? {
            key: fs.readFileSync(path.join(rootCertDir, 'dev-key.pem')),
            cert: fs.readFileSync(path.join(rootCertDir, 'dev-cert.pem'))
          }
        : false,
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true
        },
        '/socket.io': {
          target: backendUrl,
          ws: true,
          changeOrigin: true
        }
      }
    },
    build: {
      sourcemap: true
    }
  };
});

