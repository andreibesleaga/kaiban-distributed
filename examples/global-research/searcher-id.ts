// SPDX-License-Identifier: GPL-3.0-only
/**
 * Searcher identity: which `searcher-<n>` card a replica publishes as.
 *
 * Each replica claims the next index from a Redis counter and remembers it per
 * host key (host name and pid: a container restarted in place keeps both, local
 * replicas on one machine differ by pid), so a replica that is restarted in
 * place (compose `restart: on-failure` keeps the container) takes ITS OLD id back:
 * no second process publishes as another live card, and the dead card is reused
 * instead of staying stuck. A new stack starts on a fresh Redis (the example
 * compose files keep no Redis volume), so the counter restarts at 0. With a
 * long-lived Redis, delete both keys when you recreate the searchers.
 */
export const SEARCHER_COUNTER_KEY = 'kaiban:searcher:reg';
export const SEARCHER_HOSTS_KEY = 'kaiban:searcher:hosts';

/** The Redis commands the id assignment needs (an ioredis client satisfies it). */
export interface SearcherIdRedis {
  hget(key: string, field: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
}

/** `SEARCHER_ID` if set, else the id remembered for this host, else the next free index. */
export async function assignSearcherId(
  redis: SearcherIdRedis,
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (env['SEARCHER_ID']) return env['SEARCHER_ID'];
  const known = await redis.hget(SEARCHER_HOSTS_KEY, host);
  if (known !== null) return `searcher-${known}`;
  const next = (await redis.incr(SEARCHER_COUNTER_KEY)) - 1;
  await redis.hsetnx(SEARCHER_HOSTS_KEY, host, String(next));
  // Two starts of one host racing: the first write wins and both use it.
  const assigned = await redis.hget(SEARCHER_HOSTS_KEY, host);
  return `searcher-${assigned ?? String(next)}`;
}
