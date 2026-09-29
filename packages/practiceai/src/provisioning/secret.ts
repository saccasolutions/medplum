import { inspect } from 'node:util';

const REDACTED = '[redacted one-time secret]';

/**
 * Wraps a secret so it cannot leak through logging or serialization:
 * JSON.stringify, String(), template literals and util.inspect/console.log all
 * print a redaction marker. Call reveal() exactly where the value is needed.
 */
export class OneTimeSecret {
  readonly #value: string;

  constructor(value: string) {
    if (!value) throw new Error('empty secret');
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
