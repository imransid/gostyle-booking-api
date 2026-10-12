import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const r = (p: string) => resolve(import.meta.dirname, p);

export default defineConfig({
  test: {
    /**
     * One glob, not one per layer.
     *
     * The four-layer list silently excluded src/auth: a spec written there
     * ran nowhere and reported nothing, and the only symptom would have been
     * a green suite that never executed the file. A directory should not need
     * a config edit before its tests count.
     */
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    /**
     * Pinned, so the suite means the same on every machine. Every
     * time-shaped expectation is written in the default branch zone
     * (hold.repository.ts `DEFAULT_BRANCH_TIMEZONE`); a developer's shell
     * exporting another zone must not turn the suite red. A spec that needs
     * another zone sets it itself (branch-clock.check.spec.ts).
     */
    env: { BRANCH_TIMEZONE: 'Asia/Dhaka' },
  },
  resolve: {
    alias: {
      '@domain':         r('src/domain'),
      '@application':    r('src/application'),
      '@infrastructure': r('src/infrastructure'),
      '@interface':      r('src/interface'),
    },
  },
});
