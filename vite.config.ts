import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  test: {
    // Worktrees live under the project root, so the default glob walks straight
    // into them and runs another branch's tests alongside this one's. A test run
    // that silently includes a branch you are reviewing is worse than no test run.
    exclude: ['**/node_modules/**', '**/dist/**', 'worktrees/**'],
  },
});
