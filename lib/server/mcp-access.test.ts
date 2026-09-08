import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
}));
import { parseIntegrationToken, assertMcpOrigin } from './mcp-access';
import { CreateIntegrationSchema } from '../integration-contract';

describe('scoped agent access boundaries', () => {
  it('requires an exact high-entropy bearer format and hashes its secret', () => {
    const token =
      'aster_11111111-1111-4111-8111-111111111111.' + 'x'.repeat(43);
    const parsed = parseIntegrationToken('Bearer ' + token);
    expect(parsed.organizationId).toBe('11111111-1111-4111-8111-111111111111');
    expect(parsed.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.hash).not.toContain('x');
    for (const input of [
      null,
      token,
      'Bearer short',
      'Basic ' + token,
      'Bearer ' + token + '\n',
      'Bearer ' + token + '?other',
    ])
      expect(() => parseIntegrationToken(input)).toThrow();
  });
  it('permits header-authenticated native clients while rejecting foreign origins and hosts', () => {
    const request = (
      headers: Record<string, string>,
      url = 'http://localhost:3000/api/mcp',
    ) =>
      new Request(url, {
        method: 'POST',
        headers: { host: 'localhost:3000', ...headers },
      });
    expect(() => assertMcpOrigin(request({}))).not.toThrow();
    expect(() =>
      assertMcpOrigin(request({ origin: 'http://localhost:3000' })),
    ).not.toThrow();
    expect(() =>
      assertMcpOrigin(request({ origin: 'https://evil.invalid' })),
    ).toThrow();
    expect(() => assertMcpOrigin(request({ host: 'evil.invalid' }))).toThrow();
    expect(() =>
      assertMcpOrigin(request({ 'sec-fetch-site': 'cross-site' })),
    ).toThrow();
    expect(() =>
      assertMcpOrigin(
        request({}, 'http://localhost:3000/api/mcp?token=secret'),
      ),
    ).toThrow();
  });
  it('rejects write scopes, repeated grants, hidden fields and indefinite expiry', () => {
    const valid = {
      name: 'Local assistant',
      scopes: ['portfolio:read'],
      expiresInDays: 7,
    };
    expect(CreateIntegrationSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, scopes: ['mail:send'] },
      { ...valid, scopes: ['portfolio:read', 'portfolio:read'] },
      { ...valid, expiresInDays: 365 },
      { ...valid, organizationId: 'other' },
      { ...valid, scopes: [] },
    ])
      expect(CreateIntegrationSchema.safeParse(invalid).success).toBe(false);
  });
});
