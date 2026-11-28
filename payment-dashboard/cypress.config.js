import { defineConfig } from 'cypress'

export default defineConfig({
  e2e: {
    // `npm run dev` serves the dashboard here (see server.port in vite.config.js).
    baseUrl: 'http://localhost:3000',
    video: false,
  },
})
