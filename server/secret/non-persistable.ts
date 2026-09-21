/**
 * A value that cannot be written down by accident.
 *
 * Fest holds provider credentials in memory on the substitute path. The risk is
 * not that someone deliberately logs one — it is that a secret rides along
 * inside a context object that someone later passes to `JSON.stringify`, a log
 * line, a template string, or an error message. Every one of those is a
 * reasonable thing to write, and every one of them leaks.
 *
 * So the value is wrapped in a type whose every stringification path returns
 * `"[redacted]"`:
 *
 *   `${secret}`               -> "[redacted]"   (toString / Symbol.toPrimitive)
 *   JSON.stringify({secret})  -> {"...":"[redacted]"}
 *   console.log(secret)       -> NonPersistable [redacted]   (inspect.custom)
 *   String(secret)            -> "[redacted]"
 *
 * Reading the real value requires calling `.expose()`, which is greppable. That
 * is the whole design: leaking becomes something you have to type on purpose,
 * and a reviewer can find every place it happens with one search.
 *
 * This is a guard rail, not a boundary. It does not defend against code that
 * WANTS the value — nothing in-process can. It defends against the accident.
 */

export const REDACTED = "[redacted]";

export class NonPersistable<T> {
  /**
   * `#value` and not `_value`: a true private field is invisible to
   * `Object.keys`, to spreads, and to `JSON.stringify` even without the
   * `toJSON` below. Two independent mechanisms have to fail before a secret
   * escapes.
   */
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** The real value. Greppable on purpose — every call site should be reviewable. */
  expose(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** Covers `${secret}` and `secret + ""`, which do not go through toString alone. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return "NonPersistable";
  }

  /**
   * `util.inspect` — which is what `console.log` and most loggers use — ignores
   * `toString` entirely and would happily print the private field.
   *
   * The symbol is looked up by name rather than imported from `node:util` so
   * this module stays dependency-free and usable anywhere.
   */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `NonPersistable ${REDACTED}`;
  }
}

/** True for a wrapped value; narrows for callers that accept either. */
export function isNonPersistable(value: unknown): value is NonPersistable<unknown> {
  return value instanceof NonPersistable;
}
