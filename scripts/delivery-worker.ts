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
    await deliverOne(async (payload, id) => {
      const transport = nodemailer.createTransport(config);
      const timeout = setTimeout(() => transport.close(), 45000);
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
        transport.close();
      }
    });
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  await pool.end();
}
