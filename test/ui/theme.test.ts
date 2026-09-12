import { getThemePalette } from '../../src/ui/theme';

describe('yuNote theme', () => {
  it('provides distinct, high-contrast light and dark surfaces', () => {
    const light = getThemePalette('light');
    const dark = getThemePalette('dark');

    expect(light.background).not.toBe(light.text);
    expect(dark.background).not.toBe(dark.text);
    expect(light.background).not.toBe(dark.background);
    expect(light.accent).toBe(dark.accent);
  });
});

