import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { databaseWriterOptions, runtimeIdentity } from './lifecycle-contract';
describe('appliance release identity', () => {
  it('keeps existing native processes on the explicit legacy generation', () => {
    expect(runtimeIdentity({})).toEqual({
      release: 'legacy',
      generation: 1,
      min: 16,
      max: 16,
    });
  });
  it.each([
    { ASTER_RELEASE_ID: 'x -c role=postgres' },
    { ASTER_RELEASE_ID: 'x', ASTER_APPLICATION_RELEASE: 'y' },
    { ASTER_WRITER_GENERATION: '0' },
    { ASTER_WRITER_GENERATION: 'NaN' },
    { ASTER_WRITER_GENERATION: '1.5' },
    { ASTER_SCHEMA_MIN: '15' },
    { ASTER_SCHEMA_MAX: '17' },
  ])('rejects malformed or unsupported startup identity %j', (env) => {
    expect(() => databaseWriterOptions(env)).toThrow();
  });
  it('pins validated startup settings without accepting arbitrary PostgreSQL options', () => {
    expect(
      databaseWriterOptions({
        ASTER_RELEASE_ID: '2026.09-rc_1',
        ASTER_WRITER_GENERATION: '2',
      }),
    ).toBe(
      '-c app.release_id=2026.09-rc_1 -c app.writer_generation=2 -c app.schema_min=16 -c app.schema_max=16',
    );
  });
  it('keeps every HTTP route inside lifecycle admission/read handling', async () => {
    async function walk(dir: string): Promise<string[]> {
      return (
        await Promise.all(
          (
            await readdir(dir, { withFileTypes: true })
          ).map(async (entry) =>
            entry.isDirectory()
              ? walk(join(dir, entry.name))
              : entry.name === 'route.ts'
                ? [join(dir, entry.name)]
                : [],
          ),
        )
      ).flat();
    }
    const routes = await walk('app/api');
    expect(routes.length).toBeGreaterThan(40);
    for (const path of routes) {
      const source = await readFile(path, 'utf8');
      expect(source, path).toContain('lifecycleRoute(');
      expect(source, path).not.toMatch(
        /export async function (GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\(/,
      );
    }
  });
});
