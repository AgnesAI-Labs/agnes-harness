import { defaultExclude, defineConfig } from 'vitest/config'

// 单一事实源:include/exclude 只在这里定义一次,根 vitest.config.ts 与十三份包级
// vitest.config.ts 都直接复用这份配置(不再各自维护 include),新增目录不需要改配置(I2)。
// exclude 在 vitest 默认排除(node_modules、.git)之上追加 dist——dist 下是 tsc 编译产物副本,
// 不追加会把编译后的 .test.js 也当测试跑一遍(M7:在默认值基础上追加,不整体替换)。
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: [...defaultExclude, '**/dist/**'],
    // Windows suites start real PowerShell, daemon and worker processes; macOS hosted runners
    // also hit the default 5s deadline in unrelated suites when the full gate runs concurrently.
    // Keep functional checks finite without changing product-level deadlines.
    // Explicit per-test timeouts and CLI maxWorkers overrides still take precedence.
    ...(['win32', 'darwin'].includes(process.platform) ? { maxWorkers: 2, testTimeout: 15_000 } : {}), // guards-allow-platform: hosted OS test-runner limits.
  },
})
