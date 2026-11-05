import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertStripeAccount,
  getDirectStripeCredentials,
  selectStripeCredentialMode,
} from '../server/stripeCredentialConfig';

const validDirectEnv = {
  STRIPE_CREDENTIAL_MODE: 'direct',
  STRIPE_SECRET_KEY: 'sk_test_example',
  STRIPE_WEBHOOK_SECRET: 'whsec_example',
  EXPECTED_STRIPE_ACCOUNT_ID: 'acct_example',
};

test('managed connector remains the default, including explicit managed mode', () => {
  assert.equal(selectStripeCredentialMode({}), 'managed');
  assert.equal(selectStripeCredentialMode({ STRIPE_CREDENTIAL_MODE: 'managed' }), 'managed');
});

test('direct mode is explicit and rejects unknown selector values', () => {
  assert.equal(selectStripeCredentialMode({ STRIPE_CREDENTIAL_MODE: 'direct' }), 'direct');
  assert.throws(() => selectStripeCredentialMode({ STRIPE_CREDENTIAL_MODE: 'typo' }), /must be/);
});

test('direct mode requires all independent credentials and account pin', () => {
  for (const missing of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'EXPECTED_STRIPE_ACCOUNT_ID'] as const) {
    const env = { ...validDirectEnv, [missing]: '' };
    assert.throws(() => getDirectStripeCredentials(env), new RegExp(missing));
  }
});

test('direct mode selects valid test and live credentials outside production', () => {
  assert.equal(getDirectStripeCredentials(validDirectEnv).secretKey, 'sk_test_example');
  assert.equal(getDirectStripeCredentials({ ...validDirectEnv, STRIPE_SECRET_KEY: 'sk_live_example' }).secretKey, 'sk_live_example');
});

test('direct mode protects production from test keys and validates the account pin', () => {
  assert.throws(() => getDirectStripeCredentials({
    STRIPE_SECRET_KEY: 'sk_test_example', STRIPE_WEBHOOK_SECRET: 'whsec_example',
    EXPECTED_STRIPE_ACCOUNT_ID: 'acct_example', NODE_ENV: 'production',
  }), /test key cannot be used/);
  assert.throws(() => getDirectStripeCredentials({
    STRIPE_SECRET_KEY: 'sk_live_example', STRIPE_WEBHOOK_SECRET: 'whsec_example',
    EXPECTED_STRIPE_ACCOUNT_ID: 'not-an-account',
  }), /account ID/);
});

test('direct mode rejects malformed secret and webhook keys', () => {
  assert.throws(() => getDirectStripeCredentials({ ...validDirectEnv, STRIPE_SECRET_KEY: 'pk_live_example' }), /secret key/);
  assert.throws(() => getDirectStripeCredentials({ ...validDirectEnv, STRIPE_WEBHOOK_SECRET: 'bad_secret' }), /webhook signing secret/);
});

test('direct configuration does not fall back when incomplete', () => {
  assert.throws(() => getDirectStripeCredentials({
    STRIPE_CREDENTIAL_MODE: 'direct', REPLIT_CONNECTORS_HOSTNAME: 'unused',
  } as never), /STRIPE_SECRET_KEY/);
});

test('account pin accepts only the expected account', () => {
  assert.doesNotThrow(() => assertStripeAccount('acct_expected', 'acct_expected'));
  assert.throws(() => assertStripeAccount('acct_expected', 'acct_other'), /does not match/);
});
