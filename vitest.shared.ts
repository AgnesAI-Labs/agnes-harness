import { defaultExclude, defineConfig } from 'vitest/config'

// 单一事实源:include/exclude 只在这里定义一次,根 vitest.config.ts 与十三份包级
// vitest.config.ts 都直接复用这份配置(不再各自维护 include),新增目录不需要改配置(I2)。
// exclude 在 vitest 默认排除(node_modules、.git)之上追加 dist——dist 下是 tsc 编译产物副本,
// 不追加会把编译后的 .test.js 也当测试跑一遍(M7:在默认值基础上追加,不整体替换)。
const exclude = [...defaultExclude, '**/dist/**']

// Test tiers are chosen by file name. `*.e2e.test.ts` starts real daemons, workers or CLI processes
// and exercises real signals and exit cleanup; `*.slow.test.ts` builds large ledgers or waits on
// real timers. Both belong to `heavy`; every other test file belongs to `fast`. The two include
// sets partition `**/*.test.ts`, so running both projects runs every test file exactly once.
const heavy = ['**/*.e2e.test.ts', '**/*.slow.test.ts']

export default defineConfig({
  test: {
    exclude,
    // Windows suites start real PowerShell, daemon and worker processes. Bound file fan-out;
    // keep product deadlines intact and allow an explicit CLI maxWorkers override.
    ...(process.platform === 'win32' ? { maxWorkers: 2 } : {}), // guards-allow-platform: Windows test-process concurrency.
    projects: [
      { extends: true, test: { name: 'fast', include: ['**/*.test.ts'], exclude: [...exclude, ...heavy] } },
      { extends: true, test: { name: 'heavy', include: heavy } },
    ],
  },
})
