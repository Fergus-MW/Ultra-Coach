import type { ZoneNumber } from './types';

export const colors = {
  background: '#0B0F14',
  surface: '#141A22',
  surfaceAlt: '#1C242E',
  border: '#26313D',
  text: '#F2F6FA',
  textMuted: '#8A9AAB',
  accent: '#FF5A1F',
  accentSoft: '#FF8A5B',
  good: '#3DDC97',
  warn: '#FFC857',
  bad: '#FF4D4D',
};

export const ZONE_COLORS: Record<ZoneNumber, string> = {
  1: '#5AA9E6',
  2: '#3DDC97',
  3: '#FFC857',
  4: '#FF8A5B',
  5: '#FF4D4D',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 8,
  md: 14,
  lg: 22,
};
