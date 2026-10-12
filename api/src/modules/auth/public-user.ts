import type { User } from '@prisma/client';

/** The only shape of a user that ever leaves the API. No passwordHash, by construction. */
export interface PublicUser {
  id: string;
  email: string;
  credits: number;
  createdAt: Date;
}

export function toPublicUser(u: Pick<User, 'id' | 'email' | 'credits' | 'createdAt'>): PublicUser {
  return { id: u.id, email: u.email, credits: u.credits, createdAt: u.createdAt };
}
