import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy local para a API da OpenAI: evita CORS no browser e mantém
      // a chamada saindo do mesmo origin. A API key continua indo no
      // header Authorization enviado pelo próprio cliente.
      '/openai-api': {
        target: 'https://api.openai.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/openai-api/, ''),
      },
    },
  },
})
