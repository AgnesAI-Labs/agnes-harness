import { type IconNode, icons as lucideSubset } from './icons.js'

/**
 * Icons added after `icons.ts` reached its size ceiling. Same source and pin as that file
 * (Lucide 70562c1ee1c4fdcf736fe97bc893fb8511927934, ISC; notices in packages/web-ui/LUCIDE-LICENSE),
 * geometry unmodified.
 */
const added = {
  route: [
    ['circle', { cx: '6', cy: '19', r: '3' }],
    ['path', { d: 'M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15' }],
    ['circle', { cx: '18', cy: '5', r: '3' }],
  ],
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
  pin: [
    ['path', { d: 'M12 17v5' }],
    [
      'path',
      {
        d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
      },
    ],
  ],
  'pin-off': [
    ['path', { d: 'M12 17v5' }],
    ['path', { d: 'M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89' }],
    ['path', { d: 'm2 2 20 20' }],
    ['path', { d: 'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11' }],
  ],
  puzzle: [
    [
      'path',
      {
        d: 'M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z',
      },
    ],
  ],
  split: [
    ['path', { d: 'M16 3h5v5' }],
    ['path', { d: 'M8 3H3v5' }],
    ['path', { d: 'M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3' }],
    ['path', { d: 'm15 9 6-6' }],
  ],
  mic: [
    ['path', { d: 'M12 19v3' }],
    ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }],
    ['rect', { x: '9', y: '2', width: '6', height: '13', rx: '3' }],
  ],
  'audio-lines': [
    ['path', { d: 'M2 10v3' }],
    ['path', { d: 'M6 6v11' }],
    ['path', { d: 'M10 3v18' }],
    ['path', { d: 'M14 8v7' }],
    ['path', { d: 'M18 5v13' }],
    ['path', { d: 'M22 10v3' }],
  ],
  'volume-2': [
    [
      'path',
      {
        d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z',
      },
    ],
    ['path', { d: 'M16 9a5 5 0 0 1 0 6' }],
    ['path', { d: 'M19.364 18.364a9 9 0 0 0 0-12.728' }],
  ],
  square: [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }]],
  'loader-circle': [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]],
} as const satisfies Readonly<Record<string, readonly IconNode[]>>

/** Application symbols: compose and the existing session archive geometry. */
const projectIcons = {
  archive: [
    ['path', { d: 'M3 4h18v4H3z' }],
    ['path', { d: 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8' }],
    ['path', { d: 'M10 12h4' }],
  ],
  compose: [
    ['path', { d: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' }],
    ['path', { d: 'm16 3 5 5 M10 14l1-5 7-7 4 4-7 7z' }],
  ],
} as const satisfies Readonly<Record<string, readonly IconNode[]>>

/** The whole icon set the `Icon` primitive draws from. */
export const icons = { ...lucideSubset, ...added, ...projectIcons }
export type IconName = keyof typeof icons
