// Adapt the synchronous SQL API; transactions are owned by Durable Object storage.
export function sqliteAdapter(storage) {
  const rows = (sql, args) =>
    Array.from(storage.sql.exec(sql, ...args), (r) => ({ ...r }));
  return {
    exec(sql) {
      return rows(sql, []);
    },
    prepare(sql) {
      return {
        all(...args) {
          return rows(sql, args);
        },
        get(...args) {
          return rows(sql, args)[0];
        },
        run(...args) {
          rows(sql, args);
        },
      };
    },
    transaction(fn) {
      return storage.transactionSync(fn);
    },
  };
}
