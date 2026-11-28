const { paginationSchema } = require('./index');

describe('paginationSchema', () => {
  it('applies defaults when values are missing', () => {
    const result = paginationSchema.parse({});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
  });

  it('clamps a negative page to 1', () => {
    const result = paginationSchema.parse({ page: -1 });
    expect(result.page).toBe(1);
  });

  it('clamps a zero page to 1', () => {
    const result = paginationSchema.parse({ page: 0 });
    expect(result.page).toBe(1);
  });

  it('clamps a zero limit to 1', () => {
    const result = paginationSchema.parse({ limit: 0 });
    expect(result.limit).toBe(1);
  });

  it('clamps a negative limit to 1', () => {
    const result = paginationSchema.parse({ limit: -5 });
    expect(result.limit).toBe(1);
  });

  it('caps an oversized limit at 100', () => {
    const result = paginationSchema.parse({ limit: 1000 });
    expect(result.limit).toBe(100);
  });

  it('accepts valid in-range values unchanged', () => {
    const result = paginationSchema.parse({ page: 3, limit: 50 });
    expect(result.page).toBe(3);
    expect(result.limit).toBe(50);
  });

  it('coerces string inputs from query params', () => {
    const result = paginationSchema.parse({ page: '2', limit: '25' });
    expect(result.page).toBe(2);
    expect(result.limit).toBe(25);
  });
});
