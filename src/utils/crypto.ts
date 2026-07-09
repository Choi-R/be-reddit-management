// Cryptographic and Security Utilities for Cloudflare Workers (WebCrypto API)

export const generateSalt = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

export const hashPassword = async (p: string, s: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p + s))), b => b.toString(16).padStart(2, '0')).join('');

export const createPasswordHash = async (p: string): Promise<string> => {
  const s = generateSalt();
  return `${s}:${await hashPassword(p, s)}`;
};

export const verifyPassword = async (p: string, sf: string): Promise<boolean> => {
  const [s, h] = sf.split(':');
  return !!(s && h && (await hashPassword(p, s)) === h);
};
