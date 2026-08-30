import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Vitest config for the admin frontend. Kept separate from vite.config.ts so
// the dev/build path stays untouched — only `npm test` picks this up.
//
// Notes:
//   - jsdom, so component tests can render React.
//   - setupFiles wires @testing-library/jest-dom matchers globally.
//   - No path aliases are declared in tsconfig.json today, so no `resolve.alias`
//     block is needed here. Add one alongside a matching tsconfig `paths` entry
//     if that ever changes.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    css: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/test-setup.ts',
        'src/main.tsx',
        'src/vite-env.d.ts',
      ],
    },
  },
})
