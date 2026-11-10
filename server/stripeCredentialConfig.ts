export type StripeCredentialMode = 'managed' | 'direct';

export interface StripeCredentialEnv {
  STRIPE_CREDENTIAL_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  EXPECTED_STRIPE_ACCOUNT_ID?: string;
  NODE_ENV?: string;
}

export interface StripeCredentials {
  mode: StripeCredentialMode;
  secretKey: string;
  webhookSecret?: string;
  expectedAccountId?: string;
}

export function selectStripeCredentialMode(env: StripeCredentialEnv): StripeCredentialMode {
  const value = env.STRIPE_CREDENTIAL_MODE;
  if (value === undefined || value === '' || value === 'managed') return 'managed';
  if (value === 'direct') return 'direct';
  throw new Error('STRIPE_CREDENTIAL_MODE must be "managed" or "direct"');
}

export function getDirectStripeCredentials(env: StripeCredentialEnv): StripeCredentials {
  const required: Array<keyof StripeCredentialEnv> = [
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'EXPECTED_STRIPE_ACCOUNT_ID',
  ];
  for (const name of required) {
    if (!env[name]?.trim()) throw new Error(`${name} is required when STRIPE_CREDENTIAL_MODE=direct`);
  }

  const secretKey = env.STRIPE_SECRET_KEY!.trim();
  const expectedAccountId = env.EXPECTED_STRIPE_ACCOUNT_ID!.trim();
  if (!/^acct_[A-Za-z0-9]+$/.test(expectedAccountId)) {
    throw new Error('EXPECTED_STRIPE_ACCOUNT_ID must be a Stripe account ID beginning with acct_');
  }
  if (!/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET!.trim())) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret');
  }
  if (env.NODE_ENV === 'production' && secretKey.startsWith('sk_test_')) {
    throw new Error('A Stripe test key cannot be used when NODE_ENV=production');
  }
  if (!secretKey.startsWith('sk_live_') && !secretKey.startsWith('sk_test_')) {
    throw new Error('STRIPE_SECRET_KEY must be a Stripe secret key');
  }

  return {
    mode: 'direct',
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET!.trim(),
    expectedAccountId,
  };
}

export function assertStripeAccount(expectedAccountId: string, actualAccountId: string): void {
  if (expectedAccountId !== actualAccountId) {
    throw new Error('Stripe account does not match EXPECTED_STRIPE_ACCOUNT_ID');
  }
}
