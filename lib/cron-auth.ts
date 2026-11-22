import { createHash, timingSafeEqual } from 'node:crypto';

export function isAuthorizedCron(header: string | string[] | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || typeof header !== 'string') return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
