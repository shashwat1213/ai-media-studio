import bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { conflict, unauthorized } from '../../lib/errors.js';
import type { Credentials } from './auth.schemas.js';
import { toPublicUser, type PublicUser } from './public-user.js';

export interface AuthServiceOptions {
  bcryptCost: number;
  signupBonusCredits: number;
}

export function createAuthService(prisma: PrismaClient, opts: AuthServiceOptions) {
  // Used when the email doesn't exist, so login always does one bcrypt compare
  // and response time doesn't reveal whether an account exists.
  const dummyHash = bcrypt.hashSync('timing-equaliser-not-a-real-password', opts.bcryptCost);

  return {
    async register({ email, password }: Credentials): Promise<PublicUser> {
      const passwordHash = await bcrypt.hash(password, opts.bcryptCost);
      const bonus = opts.signupBonusCredits;
      try {
        // Nested write = ONE transaction: user + balance + ledger row, or nothing.
        const user = await prisma.user.create({
          data: {
            email,
            passwordHash,
            credits: bonus,
            transactions: bonus > 0 ? { create: { delta: bonus, reason: 'SIGNUP_BONUS', balanceAfter: bonus } } : undefined,
          },
        });
        return toPublicUser(user);
      } catch (err) {
        // P2002 = unique constraint violation (email already taken). Relying on the DB
        // constraint instead of "check then insert" avoids a race between two signups.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw conflict('Email already registered');
        }
        throw err;
      }
    },

    async login({ email, password }: Credentials): Promise<PublicUser> {
      const user = await prisma.user.findUnique({ where: { email } });
      const ok = await bcrypt.compare(password, user?.passwordHash ?? dummyHash);
      if (!user || !ok) throw unauthorized('Invalid email or password'); // same message either way
      return toPublicUser(user);
    },

    async getById(id: string): Promise<PublicUser | null> {
      const user = await prisma.user.findUnique({ where: { id } });
      return user ? toPublicUser(user) : null;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
