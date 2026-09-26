import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { AppError } from '../utils/app-error.js';

const blockedHostnames = new Set(['localhost', 'metadata.google.internal']);

function isPrivateAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() !== 'unicast';
  } catch {
    return true;
  }
}

export async function assertSafeRemoteUrl(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, 'INVALID_REMOTE_URL', 'Remote URL is invalid');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || blockedHostnames.has(hostname)) {
    throw new AppError(400, 'UNSAFE_REMOTE_URL', 'Remote URL is not permitted');
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = ipaddr.isValid(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError(400, 'INVALID_REMOTE_URL', 'Remote URL host could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new AppError(400, 'UNSAFE_REMOTE_URL', 'Remote URL resolves to a restricted address');
  }
  return url;
}
