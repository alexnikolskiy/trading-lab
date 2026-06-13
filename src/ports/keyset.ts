// Structured keyset position for time-ordered pagination. `t` is an ISO-8601 createdAt.
export interface Cursor {
  t: string;
  id: string;
}
