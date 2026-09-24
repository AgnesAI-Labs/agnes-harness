// 根级 vitest 配置与十三份包级 vitest.config.ts 用同一份 include/exclude(定义于
// vitest.shared.ts),不在这里另写一份等价 glob——'**/*.test.ts' 从仓库根出发本身就会
// 递归匹配任意包、任意深度的测试文件,不需要 packages/*/... 的显式清单(I2)。
export { default } from './vitest.shared.js'
