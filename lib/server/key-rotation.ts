import type { PoolClient } from 'pg';
import { encryptedTables } from './encrypted-records';
import {
  encrypt,
  decrypt,
  encryptionKeyId,
  activeEncryptionKeyId,
} from './crypto';
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
/** Caller owns the transaction. No plaintext or row identifiers enter the receipt. */
export async function rotateEncryptedRecords(
  client: PoolClient,
  apply: boolean,
) {
  const activeKeyId = activeEncryptionKeyId();
  if (apply && activeKeyId === 'legacy')
    throw new Error('Select a named active key before rotation');
  if (apply) {
    const owned = await client.query(
      `SELECT c.relname FROM pg_class c WHERE c.oid=ANY($1::regclass[]) AND pg_has_role(current_user,c.relowner,'USAGE')`,
      [encryptedTables.map((t) => 'public.' + t.table)],
    );
    if (owned.rows.length !== encryptedTables.length)
      throw new Error(
        'Rotation requires the schema owner; runtime credentials are refused',
      );
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(
      'LOCK TABLE ' +
        encryptedTables.map((t) => quote(t.table)).join(',') +
        ' IN ACCESS EXCLUSIVE MODE',
    );
    for (const t of encryptedTables)
      if (t.trigger)
        await client.query(
          `ALTER TABLE ${quote(t.table)} DISABLE TRIGGER ${quote(t.trigger)}`,
        );
  }
  const organizations = (
    await client.query('SELECT id FROM app_organizations ORDER BY id')
  ).rows;
  const fields: Record<
    string,
    { checked: number; changed: number; byKey: Record<string, number> }
  > = {};
  for (const t of encryptedTables) {
    for (const org of t.tenant ? organizations : [{ id: null }]) {
      if (t.tenant)
        await client.query("SELECT set_config('app.organization_id',$1,true)", [
          org.id,
        ]);
      for (let offset = 0; ; offset += 100) {
        const selected = [
          ...new Set([
            ...t.key,
            ...(t.tenant ? ['organization_id'] : []),
            ...t.fields.map((f) => f.name),
          ]),
        ]
          .map(quote)
          .join(',');
        const rows = (
          await client.query(
            `SELECT ${selected} FROM ${quote(t.table)} ${t.tenant ? 'WHERE organization_id=$1' : ''} ORDER BY ${t.key.map(quote).join(',')} LIMIT 100 OFFSET ${offset}`,
            t.tenant ? [org.id] : [],
          )
        ).rows;
        for (const row of rows) {
          for (const f of t.fields) {
            if (row[f.name] === null) continue;
            const counter = (fields[t.table + '.' + f.name] ??= {
                checked: 0,
                changed: 0,
                byKey: {},
              }),
              context = f.context(row),
              oldKey = encryptionKeyId(row[f.name]);
            const plaintext = decrypt(row[f.name], context);
            counter.checked++;
            counter.byKey[oldKey] = (counter.byKey[oldKey] ?? 0) + 1;
            if (apply && oldKey !== activeKeyId) {
              const ciphertext = encrypt(plaintext, context);
              if (!decrypt(ciphertext, context).equals(plaintext))
                throw new Error('Rotation verification failed');
              const updated = await client.query(
                `UPDATE ${quote(t.table)} SET ${quote(f.name)}=$1 WHERE ${t.key.map((k, i) => quote(k) + '=$' + (i + 2)).join(' AND ')} RETURNING ${quote(f.name)}`,
                [ciphertext, ...t.key.map((k) => row[k])],
              );
              if (
                updated.rowCount !== 1 ||
                !decrypt(updated.rows[0][f.name], context).equals(plaintext)
              )
                throw new Error('Stored ciphertext verification failed');
              counter.changed++;
            }
            plaintext.fill(0);
          }
        }
        if (rows.length < 100) break;
      }
    }
  }
  if (apply)
    for (const t of encryptedTables)
      if (t.trigger)
        await client.query(
          `ALTER TABLE ${quote(t.table)} ENABLE TRIGGER ${quote(t.trigger)}`,
        );
  return {
    result: 'passed',
    mode: apply ? 'apply' : 'dry-run',
    activeKeyId,
    fields,
    auditKey: 'legacy retained; audit signatures unchanged',
  };
}
