import { describe, expect, it } from 'vitest';
import { mcpResult } from './mcp-response';
describe('bounded MCP responses', () => {
  it('preserves structured data and bounds UTF-8 output without partial facts', () => {
    const accepted = mcpResult({ fact: 'Cited EUR 100', nextOffset: null });
    expect(accepted.structuredContent).toEqual({
      fact: 'Cited EUR 100',
      nextOffset: null,
    });
    const excessive = mcpResult({ quote: '€'.repeat(180000) });
    expect(excessive.isError).toBe(true);
    expect(excessive).not.toHaveProperty('structuredContent');
    expect(excessive.content[0].text).toContain('Reduce limit');
  });
});
