/**
 * Fastify `trustProxy` setting for "exactly N reverse proxies sit in front of us".
 *
 * Fastify derives `request.ip` (the key for every per-IP rate limit) from
 * `X-Forwarded-For`. `trustProxy: true` trusts every hop, and since a client can send
 * its own `X-Forwarded-For` — which a proxy such as nginx only *appends* to — the
 * leftmost, client-chosen entry would become `request.ip`, letting an attacker dodge
 * the login/register limits by rotating the header. Trusting only the N hops we
 * actually operate makes `request.ip` the address our outermost proxy itself observed.
 *
 * `hop` counts from the socket peer (0) outward, so `hop < hops` trusts exactly the
 * `hops` nearest proxies. 0 disables forwarded-header trust altogether. (A hop-count
 * function rather than a bare number because Fastify's TypeScript types omit the
 * number form although its address resolver supports the same semantics.)
 */
export function resolveTrustProxy(
  hops: number,
): false | ((address: string, hop: number) => boolean) {
  if (hops <= 0) return false;
  return (_address, hop) => hop < hops;
}
