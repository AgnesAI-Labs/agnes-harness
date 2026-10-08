import { describe, expect, it } from 'vitest'
import { evaluateComputerUseAppAdmission } from '../../src/computer-use/app-admission.js'

const hash = '1'.repeat(64)
const windowsIdentity = {
  platform: 'win32' as const,
  executablePath: 'C:\\Program Files\\Acme\\Editor.exe',
  mappedImagePath: '\\Device\\HarddiskVolume1\\Program Files\\Acme\\Editor.exe',
  imageBinding: 'mapped-image-file-handle-v1' as const,
  publisherSha256: hash,
  processStartTime: '134342737068640855',
}
const packagedIdentity = {
  platform: 'win32' as const,
  executablePath:
    'C:\\Program Files\\WindowsApps\\Microsoft.Paint_1_x64__8wekyb3d8bbwe\\PaintApp\\mspaint.exe',
  mappedImagePath:
    '\\Device\\HarddiskVolume1\\Program Files\\WindowsApps\\Microsoft.Paint_1_x64__8wekyb3d8bbwe\\PaintApp\\mspaint.exe',
  imageBinding: 'mapped-image-file-handle-v1' as const,
  packageFamilyName: 'Microsoft.Paint_8wekyb3d8bbwe',
  processStartTime: '134342737068640856',
}

describe('Computer Use stable application admission', () => {
  it('fails closed for the default empty allowlist and ignores display names', () => {
    expect(evaluateComputerUseAppAdmission(windowsIdentity, [])).toEqual({
      allowed: false,
      code: 'app_not_allowlisted',
    })
  })

  it('requires the exact executable identity and signing certificate', () => {
    expect(
      evaluateComputerUseAppAdmission(windowsIdentity, [
        {
          platform: 'win32',
          executablePath: 'c:\\program files\\acme\\EDITOR.EXE',
          publisherSha256: hash,
        },
      ]),
    ).toEqual({ allowed: true })
    expect(
      evaluateComputerUseAppAdmission(windowsIdentity, [
        {
          platform: 'win32',
          executablePath: windowsIdentity.executablePath,
          publisherSha256: '2'.repeat(64),
        },
      ]),
    ).toEqual({ allowed: false, code: 'app_not_allowlisted' })
  })

  it('admits a packaged Windows app only by exact path and OS package family', () => {
    expect(
      evaluateComputerUseAppAdmission(packagedIdentity, [
        {
          platform: 'win32',
          executablePath: packagedIdentity.executablePath,
          packageFamilyName: packagedIdentity.packageFamilyName,
        },
      ]),
    ).toEqual({ allowed: true })
    expect(
      evaluateComputerUseAppAdmission(packagedIdentity, [
        {
          platform: 'win32',
          executablePath: packagedIdentity.executablePath,
          packageFamilyName: 'Microsoft.Fake_8wekyb3d8bbwe',
        },
      ]),
    ).toEqual({ allowed: false, code: 'app_not_allowlisted' })
  })

  it('allows any valid ordinary identity in trusted all-apps mode but keeps hard denies', () => {
    expect(evaluateComputerUseAppAdmission(packagedIdentity, [], true)).toEqual({ allowed: true })
    expect(evaluateComputerUseAppAdmission({ ...packagedIdentity, category: 'payment' }, [], true)).toEqual({
      allowed: false,
      code: 'app_hard_denied',
    })
  })

  it('admits a strict-validated Apple platform app without a Team ID only in all-apps mode', () => {
    const applePlatformIdentity = {
      platform: 'darwin' as const,
      bundleId: 'com.apple.finder',
      signatureSha256: hash,
      processStartTime: 'darwin:1700000000.000001:1700000001.000002',
    }
    expect(evaluateComputerUseAppAdmission(applePlatformIdentity, [], true)).toEqual({ allowed: true })
    expect(
      evaluateComputerUseAppAdmission(applePlatformIdentity, [
        {
          platform: 'darwin',
          bundleId: 'com.apple.finder',
          teamId: 'APPLE12345',
          signatureSha256: hash,
        },
      ]),
    ).toEqual({ allowed: false, code: 'app_not_allowlisted' })
  })

  it.each(['terminal', 'password-manager', 'system-security', 'payment', 'two-factor'])(
    'hard-denies %s even when the stable identity is explicitly allowlisted',
    (category) => {
      expect(
        evaluateComputerUseAppAdmission({ ...windowsIdentity, category }, [
          {
            platform: 'win32',
            executablePath: windowsIdentity.executablePath,
            publisherSha256: hash,
          },
        ]),
      ).toEqual({ allowed: false, code: 'app_hard_denied' })
    },
  )

  it('rejects malformed identities instead of approximating them', () => {
    expect(
      evaluateComputerUseAppAdmission({ ...windowsIdentity, publisherSha256: 'not-a-digest' }, []),
    ).toEqual({ allowed: false, code: 'app_identity_invalid' })
    expect(
      evaluateComputerUseAppAdmission({ ...windowsIdentity, imageBinding: 'path-only' as never }, []),
    ).toEqual({ allowed: false, code: 'app_identity_invalid' })
  })
})
