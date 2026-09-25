import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const local = (specifier: string): string => fileURLToPath(new URL(specifier, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: local('./node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: local('./node_modules/react/jsx-runtime.js') },
      { find: /^react-dom$/, replacement: local('./node_modules/react-dom/index.js') },
      { find: /^react-dom\/client$/, replacement: local('./node_modules/react-dom/client.js') },
    ],
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
  },
})
