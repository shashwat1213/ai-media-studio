import { z } from 'zod';

// Same rules as the API (api/src/modules/auth/auth.schemas.ts). Client-side
// validation is for UX only — the server re-validates everything.
export const credentialsSchema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters').max(72, 'At most 72 characters'),
});

export type Credentials = z.infer<typeof credentialsSchema>;
