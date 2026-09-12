import { runWorkerOperation } from '../lib/server/lifecycle';
import nodemailer from 'nodemailer';
import { writeFile } from 'node:fs/promises';
import { deliverOne, smtpConfiguration } from '../lib/server/delivery';
import { pool, assertDatabaseRole } from '../lib/server/db';
await assertDatabaseRole();
const config = smtpConfiguration();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
  });
try {
  while (!stopping) {
    await writeFile(
      process.env.DELIVERY_HEARTBEAT_FILE ?? '/tmp/aster-delivery-heartbeat',
      String(Date.now()),
    );
    await runWorkerOperation('delivery', async (signal) =>
      deliverOne(async (payload, id) => {
        signal.throwIfAborted();
        const transport = nodemailer.createTransport(config);
        const timeout = setTimeout(() => transport.close(), 45000);
        const cancelAdmission = () => transport.close();
        signal.addEventListener('abort', cancelAdmission, { once: true });
        try {
          await transport.sendMail({
            ...payload,
            from: config.from,
            messageId: `<${id}@aster.local>`,
            disableFileAccess: true,
            disableUrlAccess: true,
          });
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener('abort', cancelAdmission);
          transport.close();
        }
      }),
    );
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  await pool.end();
}
