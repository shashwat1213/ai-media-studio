import type { CreditReason } from '@/lib/api';

export const reasonLabel: Record<CreditReason, string> = {
  SIGNUP_BONUS: 'Signup bonus',
  PURCHASE: 'Purchase',
  GENERATION: 'Generation',
  REFUND: 'Refund',
};
