// SQLite on Node and Cloudflare use the same synchronous unit of work.
export function transaction(db, fn) {
  if (db.transaction) return db.transaction(fn);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
