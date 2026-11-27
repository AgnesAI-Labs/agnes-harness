import type { LocaleCatalog } from '@agnes/web-ui'

export const communityReleaseCatalog: LocaleCatalog = {
  en: {
    'community.typeUnknown': 'Unknown type',
    'community.compatibility': 'AGH compatibility',
    'community.compatibility.declared-compatible': 'Declared compatible',
    'community.compatibility.incompatible': 'Incompatible',
    'community.compatibility.undeclared': 'Not declared',
    'community.compatibility.unknown': 'Unable to determine',
    'community.compatibilityNotice':
      'A matching declaration does not mean the plugin passed an installation check.',
    'community.commitTime': 'Version commit time',
    'community.commitTimeNotice':
      'The catalog reports the Git committer time, not when the version was listed.',
    'community.notRecorded': 'Not recorded',
    'community.commit': 'Pinned commit',
  },
  'zh-CN': {
    'community.typeUnknown': '类型未知',
    'community.compatibility': 'AGH 兼容性',
    'community.compatibility.declared-compatible': '声明兼容',
    'community.compatibility.incompatible': '明确不兼容',
    'community.compatibility.undeclared': '未声明',
    'community.compatibility.unknown': '无法判断',
    'community.compatibilityNotice': '声明的范围匹配不代表插件已通过安装检查。',
    'community.commitTime': '版本提交时间',
    'community.commitTimeNotice': '这是目录记录的 Git 提交者时间，不是版本上架时间。',
    'community.notRecorded': '未记录',
    'community.commit': '固定提交',
  },
}
