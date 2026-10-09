import { fileURLToPath } from 'node:url'
import { defaultExclude, defineConfig } from 'vitest/config'

const zeroTestReporter = fileURLToPath(new URL('./tools/guards/src/zero-test-reporter.mjs', import.meta.url))

// 单一事实源:include/exclude 只在这里定义一次,根 vitest.config.ts 与十三份包级
// vitest.config.ts 都直接复用这份配置(不再各自维护 include),新增目录不需要改配置(I2)。
// exclude 在 vitest 默认排除(node_modules、.git)之上追加 dist——dist 下是 tsc 编译产物副本,
// 不追加会把编译后的 .test.js 也当测试跑一遍(M7:在默认值基础上追加,不整体替换)。
// Vitest applies the `--exclude` CLI flag to the root config only, not inside `projects`, so a run
// that must hold named files out (CI runs a few contention-sensitive files alone on Windows) lists
// them in AGNES_TEST_EXCLUDE as comma-separated globs relative to the repository root (run from the
// root). A non-empty list is printed so a stray variable cannot silently drop tests.
const held = (process.env.AGNES_TEST_EXCLUDE ?? '')
  .split(',')
  .map((glob) => glob.trim())
  .filter(Boolean)
if (held.length > 0) process.stderr.write(`AGNES_TEST_EXCLUDE holds out: ${held.join(', ')}\n`)
const exclude = [...defaultExclude, '**/dist/**', ...held]

// Test tiers are chosen by file name. `*.e2e.test.*` starts real daemons, workers or CLI processes
// and exercises real signals and exit cleanup; `*.slow.test.*` builds large ledgers or waits on
// real timers. Both belong to `heavy`; every other test file belongs to `fast`. The two include
// sets partition `**/*.test.{ts,tsx,jsx}`, so running both projects runs every test file exactly
// once. The extension set covers `.tsx`/`.jsx` tests: the include pattern used to be `.ts` only,
// so component tests written as `.tsx` were never collected (the zero-test reporter above now
// fails the run when a file collects nothing instead of hiding it).
const heavy = ['**/*.e2e.test.{ts,tsx,jsx}', '**/*.slow.test.{ts,tsx,jsx}']

export default defineConfig({
  test: {
    exclude,
    reporters: ['default', zeroTestReporter],
    // Windows suites start real PowerShell, daemon and worker processes; macOS hosted runners
    // also hit the default 5s deadline in unrelated suites when the full gate runs concurrently.
    // Keep functional checks finite without changing product-level deadlines.
    // Explicit per-test timeouts and CLI maxWorkers overrides still take precedence.
    ...(['win32', 'darwin'].includes(process.platform) ? { maxWorkers: 2, testTimeout: 15_000 } : {}), // guards-allow-platform: hosted OS test-runner limits.
    // Hosted runners also run the Vite coordinator and dependency transforms. Keep one isolated
    // fork per runner; shard across runners rather than sharing all CPUs with test workers.
    ...(process.env.CI ? { maxWorkers: 1, pool: 'forks' as const } : {}),
    projects: [
      // `extends: true` concatenates the root exclude, so fast only adds the heavy globs.
      { extends: true, test: { name: 'fast', include: ['**/*.test.{ts,tsx,jsx}'], exclude: heavy } },
      { extends: true, test: { name: 'heavy', include: heavy } },
    ],
  },
})
