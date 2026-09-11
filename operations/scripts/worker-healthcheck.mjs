import { statSync } from 'node:fs';
try {
  const file =
    process.env.ASTER_SERVICE === 'archive'
      ? process.env.ARCHIVE_HEARTBEAT_FILE || '/tmp/aster-archive-heartbeat'
      : process.env.ASTER_SERVICE === 'report-obligations'
        ? process.env.REPORT_OBLIGATIONS_HEARTBEAT_FILE ||
          '/tmp/aster-report-obligations-heartbeat'
        : process.env.ASTER_SERVICE === 'folder'
          ? process.env.FOLDER_HEARTBEAT_FILE || '/tmp/aster-folder-heartbeat'
          : process.env.WORKER_HEARTBEAT_FILE || '/tmp/aster-worker-heartbeat';
  // Updated after successful queue polls, including no work. Bounded job time must fit.
  const age = Date.now() - statSync(file).mtimeMs;
  process.exit(age >= 0 && age < 180_000 ? 0 : 1);
} catch {
  process.exit(1);
}
