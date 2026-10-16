import { describe, expect, it } from 'vitest';
import { stripScroll } from '../ui/place.js';

describe('a tab strip on a narrow screen', () => {
  // A strip 358px wide, scrolled to its start; tabs from the start of its content.
  const strip = { scrollLeft: 0, width: 358 };

  it('scrolls a tab that is off its right edge into view, a little clear of the edge', () => {
    expect(stripScroll(strip, { left: 468, width: 59 })).toBe(468 + 59 + 16 - 358);
  });

  it('scrolls back to a tab off its left edge, and to the start of a tab wider than the strip', () => {
    expect(stripScroll({ scrollLeft: 300, width: 358 }, { left: 120, width: 80 })).toBe(104);
    expect(stripScroll({ scrollLeft: 300, width: 358 }, { left: 8, width: 80 })).toBe(0);
    expect(stripScroll(strip, { left: 400, width: 500 })).toBe(384);
  });

  it('leaves a strip alone when its tab shows already', () => {
    expect(stripScroll(strip, { left: 0, width: 84 })).toBeNull();
    expect(stripScroll({ scrollLeft: 200, width: 358 }, { left: 300, width: 80 })).toBeNull();
  });
});
