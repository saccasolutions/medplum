import type { ProvisionPracticeInput } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TAXONOMY = /^[0-9]{3}[0-9A-Z]{6}X$/;

export class ProvisioningInputError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid provisioning input: ${problems.join('; ')}`);
    this.name = 'ProvisioningInputError';
    this.problems = problems;
  }
}

/** NPI check digit (Luhn over "80840" + first 9 digits), per CMS NPI standard. */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

/** Append the check digit to a 9-digit NPI prefix (for synthetic test data). */
export function npiWithCheckDigit(prefix9: string): string {
  if (!/^\d{9}$/.test(prefix9)) throw new Error('expected 9 digits');
  for (let d = 0; d <= 9; d++) {
    if (isValidNpi(`${prefix9}${d}`)) return `${prefix9}${d}`;
  }
  throw new Error('unreachable');
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Validate and normalize (trim, lowercase e-mails, UUID lowercase). Throws ProvisioningInputError. */
export function normalizeProvisionInput(input: ProvisionPracticeInput): ProvisionPracticeInput {
  const problems: string[] = [];
  const practiceName = input.practiceName?.trim() ?? '';
  if (!practiceName) problems.push('practiceName is required');
  if (practiceName.length > 200) problems.push('practiceName is too long');
  const organizationId = input.organizationId?.trim().toLowerCase() ?? '';
  if (!isUuid(organizationId)) problems.push('organizationId must be the billing organization UUID');
  const adminEmail = input.adminEmail?.trim().toLowerCase() ?? '';
  if (!EMAIL.test(adminEmail)) problems.push('adminEmail must be an e-mail address');
  if (input.groupNpi !== undefined && !isValidNpi(input.groupNpi)) problems.push('groupNpi is not a valid NPI');
  if (input.taxonomy !== undefined && !TAXONOMY.test(input.taxonomy)) problems.push('taxonomy must be a NUCC taxonomy code');
  const seenNpi = new Set<string>();
  const seenEmail = new Set<string>([adminEmail]);
  const providers = (input.providers ?? []).map((p, i) => {
    const npi = p.npi?.trim() ?? '';
    if (!isValidNpi(npi)) problems.push(`providers[${i}].npi is not a valid NPI`);
    if (seenNpi.has(npi)) problems.push(`providers[${i}].npi is duplicated`);
    seenNpi.add(npi);
    const firstName = p.firstName?.trim() ?? '';
    const lastName = p.lastName?.trim() ?? '';
    if (!firstName || !lastName) problems.push(`providers[${i}] needs firstName and lastName`);
    if (p.taxonomy !== undefined && !TAXONOMY.test(p.taxonomy)) problems.push(`providers[${i}].taxonomy must be a NUCC taxonomy code`);
    let email: string | undefined;
    if (p.email !== undefined) {
      email = p.email.trim().toLowerCase();
      if (!EMAIL.test(email)) problems.push(`providers[${i}].email must be an e-mail address`);
      // One membership per user per project: a person who is both admin and provider
      // needs a combined policy, which this tool does not create.
      if (seenEmail.has(email)) problems.push(`providers[${i}].email duplicates another user of this practice`);
      seenEmail.add(email);
    }
    return {
      npi,
      firstName,
      lastName,
      ...(email ? { email } : {}),
      ...(p.suffix ? { suffix: p.suffix.trim() } : {}),
      ...(p.taxonomy ? { taxonomy: p.taxonomy } : {}),
    };
  });
  if (problems.length > 0) throw new ProvisioningInputError(problems);
  return {
    practiceName,
    organizationId,
    adminEmail,
    adminFirstName: input.adminFirstName?.trim() || 'Practice',
    adminLastName: input.adminLastName?.trim() || 'Admin',
    providers,
    ...(input.groupNpi ? { groupNpi: input.groupNpi } : {}),
    ...(input.taxonomy ? { taxonomy: input.taxonomy } : {}),
  };
}
