import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const s7Target = 'http://127.0.0.1:4103'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 4101,
    strictPort: true,
    proxy: {
      '/api/s7': {
        target: s7Target,
        changeOrigin: true,
      },
      '/api/twin': {
        target: s7Target,
        changeOrigin: true,
      },
      '/api/system': {
        target: s7Target,
        changeOrigin: true,
      },
    },
  },
})
