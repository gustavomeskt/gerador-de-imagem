import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Rotas do backend local (pasta server/, que guarda a chave da OpenAI).
      // O navegador nunca fala direto com a OpenAI nem envia chave nenhuma.
      // 127.0.0.1 (e não "localhost") evita o Windows resolver pra IPv6.
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
  },
})
