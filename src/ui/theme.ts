export type ThemeMode = 'light' | 'dark';

export interface ThemePalette {
  mode: ThemeMode;
  background: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  mutedText: string;
  border: string;
  accent: string;
  accentSecondary: string;
  accentSoft: string;
  danger: string;
  statusBar: string;
  navigationBar: string;
  onAccent: string;
  input: string;
}

const shared = {
  accent: '#3378F6',
  accentSecondary: '#6D38F5',
  danger: '#D7445B',
  onAccent: '#FFFFFF',
};

const palettes: Record<ThemeMode, ThemePalette> = {
  light: {
    mode: 'light',
    background: '#F4F7FF',
    surface: '#FFFFFF',
    surfaceRaised: '#FCFDFF',
    text: '#171A2B',
    mutedText: '#68708A',
    border: '#DDE4F5',
    accentSoft: '#E8EEFF',
    statusBar: '#F4F7FF',
    navigationBar: '#F4F7FF',
    input: '#EEF2FB',
    ...shared,
  },
  dark: {
    mode: 'dark',
    background: '#10111D',
    surface: '#191B2B',
    surfaceRaised: '#22243A',
    text: '#F7F8FF',
    mutedText: '#A9AEC3',
    border: '#30344D',
    accentSoft: '#252D55',
    statusBar: '#10111D',
    navigationBar: '#10111D',
    input: '#24273A',
    ...shared,
  },
};

export function getThemePalette(mode: ThemeMode): ThemePalette {
  return palettes[mode];
}

