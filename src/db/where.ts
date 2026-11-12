/** One AND-ed condition and the values its `?` placeholders bind, in order. */
export interface Clause {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** One row of a filter table: its clause, or null when the option it reads is unset. */
export type Filter<O> = (opts: O) => Clause | null;

export function clause(sql: string, ...params: unknown[]): Clause {
  return { sql, params };
}

/** Params concatenate in clause order, so each value binds the placeholder written beside it. */
export function whereSQL(clauses: readonly (Clause | null)[]): Clause {
  const kept = clauses.filter((c): c is Clause => c !== null);
  return {
    sql: kept.length ? `WHERE ${kept.map((c) => c.sql).join(" AND ")}` : "",
    params: kept.flatMap((c) => c.params),
  };
}
