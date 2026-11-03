import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri expects a fixed dev port and no screen clearing.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
})
