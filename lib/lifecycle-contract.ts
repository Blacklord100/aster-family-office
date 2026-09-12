export const SUPPORTED_SCHEMA = { min: 16, max: 16 } as const;
export type LifecycleMode = 'open' | 'draining' | 'maintenance';
export type LifecycleState = {
  enabled: boolean;
  mode: LifecycleMode;
  generation: number;
  activeRelease: string;
  schemaVersion: number;
  resumedAt: string | null;
  updatedAt: string;
};
export type LifecycleStatus = LifecycleState & {
  ok: true;
  activeOperations: number;
  activeLeases: {
    document: number;
    mailbox: number;
    folder: number;
    archive: number;
    reporting: number;
    delivery: number;
    total: number;
  };
  canSeal: boolean;
};
export class LifecycleError extends Error {
  constructor(
    readonly code:
      | 'MAINTENANCE_READ_ONLY'
      | 'WRITER_FENCED'
      | 'SCHEMA_INCOMPATIBLE'
      | 'LIFECYCLE_UNAVAILABLE'
      | 'OPERATION_EXPIRED'
      | 'DRAIN_BUSY'
      | 'GENERATION_CONFLICT'
      | 'LIFECYCLE_STATE_CONFLICT'
      | 'MIGRATION_CHECKSUM_MISMATCH'
      | 'LEGACY_CHECKSUM_ADOPTION_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'LifecycleError';
  }
}
export function runtimeIdentity(
  environment: Record<string, string | undefined> = process.env,
) {
  const release =
    environment.ASTER_RELEASE_ID ??
    environment.ASTER_APPLICATION_RELEASE ??
    'legacy';
  if (
    environment.ASTER_RELEASE_ID &&
    environment.ASTER_APPLICATION_RELEASE &&
    environment.ASTER_RELEASE_ID !== environment.ASTER_APPLICATION_RELEASE
  )
    throw new Error('Conflicting release identities');
  const generation = Number(environment.ASTER_WRITER_GENERATION ?? 1),
    min = Number(environment.ASTER_SCHEMA_MIN ?? SUPPORTED_SCHEMA.min),
    max = Number(environment.ASTER_SCHEMA_MAX ?? SUPPORTED_SCHEMA.max);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(release) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < SUPPORTED_SCHEMA.min ||
    max > SUPPORTED_SCHEMA.max ||
    min > max
  )
    throw new Error('Invalid or unsupported runtime release/schema identity');
  return { release, generation, min, max };
}
export function databaseWriterOptions(
  environment: Record<string, string | undefined> = process.env,
) {
  const r = runtimeIdentity(environment);
  return `-c app.release_id=${r.release} -c app.writer_generation=${r.generation} -c app.schema_min=${r.min} -c app.schema_max=${r.max}`;
}
