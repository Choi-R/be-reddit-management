import { BusinessError } from './errors';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): void {
  if (typeof email !== 'string' || !EMAIL_REGEX.test(email) || email.length > 254) {
    throw new BusinessError('INVALID_INPUT', 'A valid email address is required (max 254 characters)');
  }
}

export function validateStringField(value: unknown, name: string, maxLength = 1000): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BusinessError('MISSING_FIELD', `${name} is required`);
  }
  if (value.length > maxLength) {
    throw new BusinessError('INVALID_INPUT', `${name} is too long (max ${maxLength} characters)`);
  }
}

export function extractRedditUsername(input: string): string {
  if (!input) return '';
  let cleaned = input.trim();

  // Strip protocol, host, and optional subdomain
  cleaned = cleaned.replace(/^(https?:\/\/)?(www\.)?reddit\.com\//i, '');

  // Strip leading slash
  cleaned = cleaned.replace(/^\//, '');

  // Strip leading user/ or u/
  if (cleaned.toLowerCase().startsWith('user/')) {
    cleaned = cleaned.substring(5);
  } else if (cleaned.toLowerCase().startsWith('u/')) {
    cleaned = cleaned.substring(2);
  }

  // Take the first segment (strip trailing slashes/subpaths)
  cleaned = cleaned.split('/')[0];

  // Strip any remaining u/ prefix (for cases like "u/john_doe" without a URL)
  cleaned = cleaned.replace(/^\/?u\//i, '');

  return cleaned.trim();
}
