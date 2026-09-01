import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared-music/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['shared-music/src/**/*.test.ts', 'src/**/*.test.ts'],
  },
})
