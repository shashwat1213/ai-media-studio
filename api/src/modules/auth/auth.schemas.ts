import { z } from 'zod';

export const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(254),
  // 72 = bcrypt's input limit; longer passwords would be silently truncated.
  password: z.string().min(8, 'At least 8 characters').max(72, 'At most 72 characters'),
});

export type Credentials = z.infer<typeof CredentialsSchema>;
