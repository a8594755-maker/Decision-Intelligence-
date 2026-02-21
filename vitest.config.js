import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,

    // Default: node (fastest for domain/utils pure functions)
    // Individual test files can override with @vitest-environment jsdom
    environment: 'node',

    // Auto-switch to jsdom for component/view tests
    environmentMatchGlobs: [
      ['src/components/**/*.test.{js,jsx}', 'jsdom'],
      ['src/views/**/*.test.{js,jsx}', 'jsdom'],
    ],

    // Setup file for jsdom environment tests
    setupFiles: ['./src/test/setup.js'],

    include: [
      'src/**/*.test.{js,jsx}',
      'tests/domain/**/*.test.{js,jsx}',
    ],
    exclude: [
      'node_modules/**',
      'dist/**',
      'src/ml/**',
      'tests/regression/**',
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      include: [
        'src/domains/**/*.js',
        'src/utils/**/*.js',
        'src/services/**/*.js',
        'src/risk/**/*.js',
        'src/components/**/*.{js,jsx}',
      ],
      exclude: [
        'node_modules/**',
        'dist/**',
        '*.config.{js,ts}',
        'src/main.jsx',
        'src/test/**',
        'src/**/*.test.{js,jsx}',
        'src/ml/**',
        'src/**/__mocks__/**',
        'src/components/ui/EXAMPLE_USAGE.jsx',
      ],

      // Coverage thresholds — start conservative, ratchet up over time
      thresholds: {
        lines: 60,
        functions: 55,
        branches: 50,
        statements: 60,
      },
    },

    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        maxThreads: 4,
      },
    },

    reporters: ['verbose', 'json'],
    outputFile: {
      json: './test-results/vitest-results.json',
    },
  },
});
