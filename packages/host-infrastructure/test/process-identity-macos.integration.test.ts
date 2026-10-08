// Integration test: compiles the REAL C helper and spawns the REAL compiled binary, unlike
// process-identity-macos.test.ts which only exercises the TS parsing logic against canned
// stdout. Skipped gracefully (not a failure) on any non-darwin platform, or if no C compiler is
// on PATH, since this is a macOS dev/CI-machine concern only.
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { legacyMacosProcessIdentity, macosProcessIdentity } from '../src/adapters/process-identity-macos.js'

function hasCompiler(): boolean {
  try {
    execFileSync('cc', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const skip = process.platform !== 'darwin' || !hasCompiler()

describe.skipIf(skip)('macosProcessIdentity against the real compiled helper', () => {
  let binary: string
  let workDir: string
  let clockBinary: string

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agnes-macos-process-identity-'))
    binary = join(workDir, 'macos-process-identity')
    const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'macos-process-identity.c')
    execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-o', binary, source])
    // Compile the production helper against deterministic kernel responses. No system clock changes.
    const fixture = join(workDir, 'clock-fixture.c')
    clockBinary = join(workDir, 'clock-fixture')
    writeFileSync(
      fixture,
      `
#include <libproc.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <string.h>
#include <errno.h>
#include <stdlib.h>
static int phase;
static int fixture_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  (void)pid; (void)flavor; (void)arg;
  struct proc_bsdinfo *info = buffer;
  memset(buffer, 0, size);
  info->pbi_start_tvsec = 2000;
  info->pbi_start_tvusec = phase == 3 ? 3 : 2;
  return size;
}
static int fixture_sysctl(const char *name, void *buffer, size_t *size, void *next, size_t next_size) {
  (void)next; (void)next_size;
  if (strcmp(name, "kern.boottime") == 0) {
    struct timeval value = { phase == 1 ? 999 : 1000, phase == 1 ? 925027 : 0 };
    memcpy(buffer, &value, sizeof(value)); *size = sizeof(value); return 0;
  }
  if (strcmp(name, "kern.bootsessionuuid") == 0 && phase != 4) {
    const char *value = phase == 2 ? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" : "11111111-2222-3333-4444-555555555555";
    memcpy(buffer, value, 37); *size = 37; return 0;
  }
  errno = ENOENT; return -1;
}
#define proc_pidinfo fixture_pidinfo
#define sysctlbyname fixture_sysctl
#define main identity_main
#include ${JSON.stringify(source)}
#undef main
int main(int argc, char **argv) {
  phase = argc > 1 ? atoi(argv[1]) : 0;
  char *args[] = { "identity", "42", "legacy" };
  return identity_main(argc > 2 ? 3 : 2, args);
}
`,
    )
    execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-o', clockBinary, fixture])
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  // Ignores the resolved default-location `bin` argument and always runs the freshly compiled
  // temp binary instead, so this test exercises the real C helper regardless of whether
  // `pnpm build:native` has been run against the checked-in packages/host/native/ location.
  const realSpawn = (_bin: string, args: string[]): Promise<{ stdout: string; code: number }> =>
    new Promise((resolve, reject) => {
      execFile(binary, args, { timeout: 2000 }, (error, stdout) => {
        if (error && typeof error.code !== 'number') {
          reject(error)
          return
        }
        resolve({ stdout: stdout.toString(), code: error ? (error.code as number) : 0 })
      })
    })

  it('reports the current test process as alive with a well-formed startId', async () => {
    const result = await macosProcessIdentity(process.pid, { spawn: realSpawn })
    expect(result.state).toBe('alive')
    if (result.state === 'alive')
      expect(result.startId).toMatch(/^darwin:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+:\d+\.\d{6}$/)
    const simulated = (phase: number) =>
      macosProcessIdentity(42, {
        spawn: async () => {
          try {
            return { stdout: execFileSync(clockBinary, [String(phase)], { encoding: 'utf8' }), code: 0 }
          } catch (error) {
            const failed = error as { stdout: string; status: number }
            return { stdout: failed.stdout, code: failed.status }
          }
        },
      })
    const before = await simulated(0)
    expect(before).toEqual({
      state: 'alive',
      startId: 'darwin:11111111-2222-3333-4444-555555555555:42:2000.000002',
    })
    const probe = (phase: number) =>
      legacyMacosProcessIdentity(42, {
        spawn: async () => ({
          stdout: execFileSync(clockBinary, [String(phase), 'legacy'], { encoding: 'utf8' }),
          code: 0,
        }),
      })
    expect(await probe(0)).toEqual({ identity: before, legacyStartId: 'darwin:1000.000000:42:2000.000002' })
    expect(await probe(1)).toEqual({ identity: before, legacyStartId: 'darwin:999.925027:42:2000.000002' })
    expect(await simulated(1)).toEqual(before) // calendar adjustment: -74.973 ms
    expect(await simulated(2)).not.toEqual(before) // new boot, identical PID and process start
    expect(await simulated(3)).not.toEqual(before) // PID reused, same boot
    expect(await simulated(4)).toEqual({ state: 'unknown', reason: 'boot-session-unavailable' })
  })

  it('reports a PID confirmed absent via process.kill(pid, 0) as dead (or unknown, never alive)', async () => {
    const candidate = 999_999
    let confirmedAbsent = false
    try {
      process.kill(candidate, 0)
    } catch (error) {
      confirmedAbsent = (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
    // If this specific high PID happens to be in use on the test machine (implausible but not
    // impossible), skip the assertion rather than risk a flaky false failure — the point of this
    // test is "never alive for a confirmed-absent PID", not "999999 is universally free".
    if (!confirmedAbsent) return
    const result = await macosProcessIdentity(candidate, { spawn: realSpawn })
    expect(result.state).not.toBe('alive')
  })
})
