import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import UnoCSS from 'unocss/vite'

export default defineConfig({
  plugins: [UnoCSS(), react()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      // wagmi connector chain pulls node:events in the browser bundle.
      events: 'events',
    },
  },
  server: { port: 5273, strictPort: false },
})
