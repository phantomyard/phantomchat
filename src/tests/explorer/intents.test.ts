import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {registry} from '../../../scripts/explorer/intents/registry';

describe('intent registry', () => {
  it('catalog has at least 20 intents covering all 7 areas', () => {
    const names = Object.keys(registry);
    expect(names.length).toBeGreaterThanOrEqual(20);
    const areas = new Set(Object.values(registry).map((d) => d.area));
    expect(areas).toContain('messaging');
    expect(areas).toContain('navigation');
    expect(areas).toContain('profile');
    expect(areas).toContain('edge');
    expect(areas).toContain('network');
    expect(areas).toContain('settings');
    expect(areas).toContain('media');
  });

  it('every intent has name, area, paramsSchema, description, exec', () => {
    for(const [name, def] of Object.entries(registry)) {
      expect(def.name).toBe(name);
      expect(def.area).toMatch(/^(messaging|profile|media|navigation|settings|network|edge)$/);
      expect(def.paramsSchema).toBeInstanceOf(z.ZodType);
      expect(typeof def.description).toBe('string');
      expect(def.description.length).toBeGreaterThan(10);
      expect(typeof def.exec).toBe('function');
    }
  });
});
