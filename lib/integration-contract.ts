import { z } from 'zod';
export const IntegrationScopeSchema = z.enum([
  'portfolio:read',
  'sources:read',
  'mailboxes:read',
]);
export type IntegrationScope = z.infer<typeof IntegrationScopeSchema>;
export const CreateIntegrationSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z
      .array(IntegrationScopeSchema)
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length),
    expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  })
  .strict();
export type IntegrationTokenInfo = {
  id: string;
  name: string;
  scopes: IntegrationScope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
