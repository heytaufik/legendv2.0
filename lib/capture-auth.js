import crypto from 'node:crypto';

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function isAuthorizedCaptureRequest({ remoteAddress, authorization, configuredToken }) {
  if (!configuredToken) return isLoopbackAddress(remoteAddress);
  if (typeof authorization !== 'string') return false;

  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return false;

  const expected = Buffer.from(configuredToken);
  const received = Buffer.from(match[1]);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
