export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: string): Result<T> => ({ ok: false, error });
export const map = <T, U>(r: Result<T>, fn: (value: T) => U): Result<U> => (r.ok ? ok(fn(r.value)) : r);
export const flatMap = <T, U>(r: Result<T>, fn: (value: T) => Result<U>): Result<U> => (r.ok ? fn(r.value) : r);
export const unwrapOr = <T>(r: Result<T>, fallback: T): T => (r.ok ? r.value : fallback);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function tryExecute<T>(fn: () => Promise<T>): Promise<Result<T>>;
export function tryExecute<T>(fn: () => T): Result<T>;
export function tryExecute<T>(
  fn: () => T | Promise<T>,
): Result<T> | Promise<Result<T>> {
  try {
    const value = fn();
    if (value instanceof Promise) {
      return value.then(
        (v): Result<T> => ({ ok: true, value: v }),
        (err): Result<T> => ({ ok: false, error: errorMessage(err) }),
      );
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
