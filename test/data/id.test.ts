import { generateId, nowIso } from '../../src/data/id';

describe('generateId', () => {
  it('returns a valid UUID v4', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('returns a different id on each call', () => {
    expect(generateId()).not.toBe(generateId());
  });
});

describe('nowIso', () => {
  it('returns a valid ISO 8601 timestamp', () => {
    const timestamp = nowIso();
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });
});
