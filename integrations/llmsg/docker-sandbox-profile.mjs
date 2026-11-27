import { readFileSync } from 'node:fs'

const input = process.argv[2]
if (!input || process.argv.length !== 3) {
  throw new Error('Usage: node integrations/llmsg/docker-sandbox-profile.mjs <docker-default-seccomp.json>')
}

const profile = JSON.parse(readFileSync(input, 'utf8'))
if (profile.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(profile.syscalls)) {
  throw new Error('Expected a default-deny Docker seccomp profile')
}

// The non-root Chromium and bubblewrap sandboxes create and configure their own namespaces.
// Linux still checks capabilities in the relevant namespace for the operations below.
profile.syscalls.push({
  names: ['setns', 'unshare', 'mount', 'umount2', 'pivot_root'],
  action: 'SCMP_ACT_ALLOW',
})

// On Linux amd64, clone takes the flags in argument 0. Leave ordinary clone to Docker's rules.
const cloneNewUser = 0x10000000
const cloneNewPid = 0x20000000
for (const flag of [cloneNewUser, cloneNewPid]) {
  profile.syscalls.push({
    names: ['clone'],
    action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: flag, valueTwo: flag, op: 'SCMP_CMP_MASKED_EQ' }],
  })
}
process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`)
