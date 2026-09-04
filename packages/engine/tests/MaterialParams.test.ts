import { describe, expect, it } from 'vitest';
import { readPath } from '../src/rendering/MaterialParams';

describe('readPath (materialParam fallback)', () => {
  const param = { path: ['userData', 'seed'], fallback: 7 };

  it('reads a present value', () => {
    expect(readPath({ userData: { seed: 3.1 } }, param)).toBe(3.1);
    expect(readPath({ userData: { seed: 0 } }, param)).toBe(0);
  });

  it('falls back when the material has no such entry (the shadow pass material)', () => {
    expect(readPath({ userData: {} }, param)).toBe(7);
    expect(readPath({}, param)).toBe(7);
    expect(readPath(null, param)).toBe(7);
    expect(readPath(undefined, param)).toBe(7);
    expect(readPath({ userData: null }, param)).toBe(7);
  });

  it('walks nested names', () => {
    const nested = { path: ['userData', 'wet', 'scale'], fallback: 1 };
    expect(readPath({ userData: { wet: { scale: 2 } } }, nested)).toBe(2);
    expect(readPath({ userData: { wet: 5 } }, nested)).toBe(1);
  });
});
