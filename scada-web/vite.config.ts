import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 9102,
    proxy: {
      '/api': 'http://127.0.0.1:9100',
    },
  },
  build: {
    outDir: mode === 'client' ? '../dist-client' : '../Mes.Api/wwwroot',
    emptyOutDir: true,
  },
}))
