import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_SIGNALING_URL || 'http://localhost:3001';
  const useHttps = env.DEV_HTTPS === 'true';

  const plugins = [react()];
  if (useHttps) {
    plugins.push(basicSsl());
  }

  return {
    plugins,
    server: {
      https: useHttps,
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

