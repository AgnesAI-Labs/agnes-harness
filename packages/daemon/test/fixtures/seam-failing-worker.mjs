// The same private IPC refusal as the production executable, without loading a Host.
process.send?.(
  {
    kind: 'worker-boot-failure',
    code: process.env.AGNES_TEST_BOOT_CODE ?? 'E_SEAM_INIT',
    reason: process.env.AGNES_TEST_BOOT_REASON,
  },
  () => process.exit(1),
)
