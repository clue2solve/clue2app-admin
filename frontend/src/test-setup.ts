// Global Vitest setup for admin frontend tests.
//
// Registers @testing-library/jest-dom matchers (toBeInTheDocument, etc.),
// hardens jsdom for MUI components that touch APIs jsdom doesn't ship, and
// resets DOM state between tests so each spec starts from a blank canvas.

import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// MUI's Autocomplete + a few other components query matchMedia during layout.
// jsdom doesn't implement it; stub a no-op so the components render.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// Same story for ResizeObserver — MUI's popper/menu positioning uses it.
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub
}

afterEach(() => {
  cleanup()
})
