import { type IconNode, icons as lucideSubset } from './icons.js'

/**
 * Icons added after `icons.ts` reached its size ceiling. Same source and pin as that file
 * (Lucide 70562c1ee1c4fdcf736fe97bc893fb8511927934, ISC; notices in packages/web-ui/LUCIDE-LICENSE),
 * geometry unmodified.
 */
const added = {
  'at-sign': [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8' }],
  ],
  'grip-vertical': [
    ['circle', { cx: '9', cy: '12', r: '1' }],
    ['circle', { cx: '9', cy: '5', r: '1' }],
    ['circle', { cx: '9', cy: '19', r: '1' }],
    ['circle', { cx: '15', cy: '12', r: '1' }],
    ['circle', { cx: '15', cy: '5', r: '1' }],
    ['circle', { cx: '15', cy: '19', r: '1' }],
  ],
  pencil: [
    [
      'path',
      {
        d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
      },
    ],
    ['path', { d: 'm15 5 4 4' }],
  ],
} as const satisfies Readonly<Record<string, readonly IconNode[]>>

/** The whole icon set the `Icon` primitive draws from. */
export const icons = { ...lucideSubset, ...added }
export type IconName = keyof typeof icons
