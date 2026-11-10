import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@twin/core': p('./packages/core/src/index.ts'),
      '@twin/twin-schema': p('./packages/twin-schema/src/index.ts'),
      '@twin/twin-data': p('./packages/twin-data/src/index.ts'),
      '@twin/nav': p('./packages/nav/src/index.ts'),
      '@twin/hazard-sdk': p('./packages/hazard-sdk/src/index.ts'),
      '@twin/routing': p('./packages/routing/src/index.ts'),
      '@twin/crowd': p('./packages/crowd/src/index.ts'),
      '@twin/hazard-fire': p('./packages/hazards/fire/src/index.ts'),
      '@twin/hazard-collapse': p('./packages/hazards/collapse/src/index.ts'),
      '@twin/hazard-earthquake': p('./packages/hazards/earthquake/src/index.ts'),
      '@twin/hazard-power': p('./packages/hazards/power/src/index.ts'),
      '@twin/dispatch': p('./packages/dispatch/src/index.ts'),
      '@twin/advisor': p('./packages/advisor/src/index.ts'),
      '@twin/sim-runtime': p('./packages/sim-runtime/src/index.ts'),
    },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
