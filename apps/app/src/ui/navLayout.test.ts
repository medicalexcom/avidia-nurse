import { NAV_DESTINATIONS, pickNavLayout } from './navLayout';
import { SIDEBAR_MIN_WIDTH } from './theme';

describe('responsive shell layout', () => {
  it('uses bottom tabs at phone widths (iPhone/Android)', () => {
    expect(pickNavLayout(375)).toBe('tabs'); // iPhone-class
    expect(pickNavLayout(412)).toBe('tabs'); // Android-class
  });

  it('uses a sidebar at tablet and desktop widths', () => {
    expect(pickNavLayout(SIDEBAR_MIN_WIDTH)).toBe('sidebar'); // tablet threshold
    expect(pickNavLayout(1440)).toBe('sidebar'); // desktop
  });

  it('exposes the navigation structure with every destination live (M12 filled the last tabs)', () => {
    const labels = NAV_DESTINATIONS.map((d) => d.label);
    expect(labels).toEqual(['Home', 'Courses', 'Study', 'Weaknesses', 'Progress', 'Profile']);
    expect(NAV_DESTINATIONS.filter((d) => d.placeholder)).toEqual([]);
  });
});
