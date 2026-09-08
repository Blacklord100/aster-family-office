import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db';
import { encrypt, decrypt, sha256 } from './crypto';
export const deliveryPayloadSchema = z
  .object({
    to: z.email().max(254),
    subject: z.string().min(1).max(150),
    text: z.string().min(1).max(12000),
  })
  .strict();
export type DeliveryPayload = z.infer<typeof deliveryPayloadSchema>;
export function emailDeliveryEnabled() {
  return process.env.EMAIL_DELIVERY_ENABLED === 'true';
}
export function smtpConfiguration() {
  if (!emailDeliveryEnabled()) throw new Error('Email delivery is disabled');
  const host = process.env.SMTP_HOST,
    port = Number(process.env.SMTP_PORT ?? 465),
    user = process.env.SMTP_USER,
    password = process.env.SMTP_PASSWORD,
    from = process.env.SMTP_FROM;
  if (
    !host ||
    !/^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/.test(host) ||
    ![465, 587].includes(port) ||
    !user ||
    !password ||
    !z.email().safeParse(from).success
  )
    throw new Error('SMTP configuration is incomplete');
  return {
    host,
    port,
    secure: port === 465,
    requireTLS: true,
    auth: { user, pass: password },
    from: from!,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}
export async function enqueueDelivery(
  payload: DeliveryPayload,
  kind: 'password_reset' | 'invitation',
  expiresAt: Date,
) {
  if (!emailDeliveryEnabled()) return;
  const data = deliveryPayloadSchema.parse(payload),
    id = randomUUID();
  await pool.query(
    'INSERT INTO app_delivery_outbox(id,recipient_hash,payload,kind,expires_at) VALUES($1,$2,$3,$4,$5)',
    [
      id,
      sha256(data.to.toLowerCase()),
      encrypt(JSON.stringify(data), 'delivery:' + id),
      kind,
      expiresAt,
    ],
  );
}
export async function deliverOne(
  send: (payload: DeliveryPayload, id: string) => Promise<void>,
): Promise<boolean> {
  await pool.query(
    "UPDATE app_delivery_outbox SET status='failed',lease_until=NULL,error_code='DELIVERY_LEASE_EXHAUSTED' WHERE status='sending' AND lease_until<now() AND attempts>=3 AND expires_at>now()",
  );
  const expired = await pool.query(
    "SELECT id FROM app_delivery_outbox WHERE status IN ('pending','failed','sending') AND expires_at<=now() LIMIT 100",
  );
  for (const row of expired.rows)
    await pool.query(
      "UPDATE app_delivery_outbox SET status='expired',payload=$2,lease_until=NULL WHERE id=$1 AND expires_at<=now()",
      [row.id, encrypt('expired', 'delivery:' + row.id)],
    );
  const row = (
    await pool.query(
      "UPDATE app_delivery_outbox SET status='sending',attempts=attempts+1,lease_until=now()+interval '90 seconds' WHERE id=(SELECT id FROM app_delivery_outbox WHERE status IN ('pending','sending') AND available_at<=now() AND expires_at>now() AND (lease_until IS NULL OR lease_until<now()) AND attempts<3 ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,payload,attempts,lease_until",
    )
  ).rows[0];
  if (!row) return false;
  try {
    await send(
      deliveryPayloadSchema.parse(
        JSON.parse(decrypt(row.payload, 'delivery:' + row.id).toString()),
      ),
      row.id,
    );
    await pool.query(
      "UPDATE app_delivery_outbox SET status='sent',payload=$2,sent_at=now(),lease_until=NULL,error_code=NULL WHERE id=$1 AND status='sending' AND lease_until=$3",
      [row.id, encrypt('delivered', 'delivery:' + row.id), row.lease_until],
    );
  } catch {
    await pool.query(
      "UPDATE app_delivery_outbox SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,available_at=now()+interval '60 seconds',lease_until=NULL,error_code='DELIVERY_FAILED' WHERE id=$1 AND status='sending' AND lease_until=$2",
      [row.id, row.lease_until],
    );
  }
  return true;
}
