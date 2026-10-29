/** Semantic colour roles. Components name a role; the theme decides what it looks like. */
export type Tone =
  | 'bg'
  | 'fg'
  | 'surface'
  | 'surfaceFg'
  | 'selection'
  | 'border'
  | 'borderStrong'
  | 'muted'
  | 'faint'
  | 'accent'
  | 'accentSoft'
  | 'onAccent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'code'
  | 'codeBg'
  | 'link'
  | 'thinking'

export const PALETTE: Record<'light' | 'dark', Record<Tone, `#${string}`>> = {
  light: {
    bg: '#FBFAFF',
    fg: '#2B2840',
    surface: '#F1EEFE',
    surfaceFg: '#2B2840',
    selection: '#E3DDFD',
    border: '#DCD7EE',
    borderStrong: '#B4ACE6',
    muted: '#6E6A86',
    faint: '#A19DB5',
    accent: '#5E57FE',
    accentSoft: '#8C84FF',
    onAccent: '#FFFFFF',
    success: '#1E8A5A',
    warning: '#B26A00',
    danger: '#D2364A',
    info: '#2F78C8',
    code: '#6B3FD0',
    codeBg: '#EFEBFD',
    link: '#4A43E6',
    thinking: '#8E8AA6',
  },
  dark: {
    bg: '#14131C',
    fg: '#E6E3F2',
    surface: '#1F1D2B',
    surfaceFg: '#ECE9F7',
    selection: '#2D2948',
    border: '#312E45',
    borderStrong: '#4E4878',
    muted: '#A29EBA',
    faint: '#6C6886',
    accent: '#8B83FF',
    accentSoft: '#B4AEFF',
    onAccent: '#14131C',
    success: '#4DD69B',
    warning: '#F2B54A',
    danger: '#FF6B7D',
    info: '#6CB6FF',
    code: '#CDB0FF',
    codeBg: '#24213A',
    link: '#A9A2FF',
    thinking: '#7F7A99',
  },
}

/** Brand gradient, darkest first. */
export const BRAND_RAMP: Record<'light' | 'dark', readonly `#${string}`[]> = {
  light: ['#3F37F0', '#5E57FE', '#7E76FF', '#A39CFF'],
  dark: ['#6F66FF', '#8B83FF', '#A9A2FF', '#C9C4FF'],
}

/** Colour-blind friendly built-ins: a base palette with the red/green state tones moved onto a blue, orange and yellow axis. */
export const DALTONIZED = {
  'dark-daltonized': {
    base: 'dark',
    tones: { success: '#5AAEFF', danger: '#FF9A4D', warning: '#F5D84A' },
  },
  'light-daltonized': {
    base: 'light',
    tones: { success: '#0B63C5', danger: '#B84F00', warning: '#8A6A00' },
  },
} as const satisfies Record<string, { base: 'light' | 'dark'; tones: Partial<Record<Tone, `#${string}`>> }>

export type DaltonizedName = keyof typeof DALTONIZED
export const isDaltonized = (name: string): name is DaltonizedName => Object.hasOwn(DALTONIZED, name)
