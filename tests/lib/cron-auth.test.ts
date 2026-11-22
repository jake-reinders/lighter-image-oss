import { afterEach, expect, it, vi } from 'vitest';
import { isAuthorizedCron } from '../../lib/cron-auth.js';

afterEach(() => vi.unstubAllEnvs());

it('rejects the literal undefined credential when the secret is missing', () => {
  vi.stubEnv('CRON_SECRET', undefined);
  expect(isAuthorizedCron('Bearer undefined')).toBe(false);
});

it.each([undefined, ['Bearer test-secret'], '', 'Bearer wrong'])('rejects invalid credentials %s', header => {
  vi.stubEnv('CRON_SECRET', 'test-secret');
  expect(isAuthorizedCron(header)).toBe(false);
});

it('requires the configured secret even in development', () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('CRON_SECRET', 'test-secret');
  expect(isAuthorizedCron(undefined)).toBe(false);
  expect(isAuthorizedCron('Bearer test-secret')).toBe(true);
});
