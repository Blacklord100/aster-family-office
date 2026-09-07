import { it, expect } from 'vitest';
import { rangeStartDate } from './date-ranges';
it('uses current periods and clamps leap/month boundaries', () => {
  expect(rangeStartDate('2027-03-31', '1M')).toBe('2027-02-28');
  expect(rangeStartDate('2024-02-29', '1Y')).toBe('2023-02-28');
  expect(rangeStartDate('2027-09-08', 'YTD')).toBe('2026-12-31');
});
