import { describe, expect, it } from 'vitest';
import { vec4 } from 'three/tsl';
import { CYBERPUNK_GRADE, ColorGradeSettings, NEUTRAL_GRADE, colorGradeHDR, colorGradeLDR } from '../src/rendering/ColorGrade';

describe('ColorGradeSettings', () => {
  it('starts neutral, takes a preset, clamps the unit knobs', () => {
    const s = new ColorGradeSettings();
    expect(s.exposure.value).toBe(1);
    expect(s.vignette.value).toBe(0);
    expect(s.lift.value.r).toBe(0);
    s.set(CYBERPUNK_GRADE);
    expect(s.contrast.value).toBeCloseTo(1.14);
    expect(s.shadowTint.value.b).toBeGreaterThan(1);
    expect(s.highlightTint.value.r).toBeGreaterThan(1);
    s.set({ vignette: 3, grain: -1, vignetteStart: 2 });
    expect(s.vignette.value).toBe(1);
    expect(s.grain.value).toBe(0);
    expect(s.vignetteStart.value).toBe(1);
    s.set(NEUTRAL_GRADE);
    expect(s.vignette.value).toBe(0);
  });

  it('builds the HDR and display stages as nodes', () => {
    const s = new ColorGradeSettings(CYBERPUNK_GRADE);
    const input = vec4(0.5, 0.5, 0.5, 1.0);
    expect(colorGradeHDR(input, s)).toBeTruthy();
    expect(colorGradeLDR(input, s)).toBeTruthy();
  });
});
