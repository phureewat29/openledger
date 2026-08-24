export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NOT_READY: 3,
  INPUT_REQUIRED: 4,
  NOT_FOUND: 5,
  INVALID: 6,
  PARTIAL: 7,
  BUSY: 8,
} as const;

export type ExitCode = keyof typeof EXIT;
