export const routes = [
  ["POST", "/api/documents", (s, a, b) => s.create(a, b)],
  [
    "POST",
    "/api/documents/:id/items/complete",
    (s, a, b, p) => s.completeItems(a, p.id, b),
  ],
  [
    "PATCH",
    "/api/documents/:id/items/:itemId",
    (s, a, b, p) => s.updateItem(a, p.id, p.itemId, b),
  ],
  [
    "PATCH",
    "/api/recurring-rules/:id",
    (s, a, b, p) => s.saveRecurringRule(a, p.id, b),
  ],
  ["PATCH", "/api/documents/:id", (s, a, b, p) => s.edit(a, p.id, b)],
  [
    "POST",
    "/api/documents/:id/actions/:action",
    (s, a, b, p) => s.action(a, p.id, p.action, b),
  ],
  ["DELETE", "/api/documents/:id", (s, a, b, p) => s.remove(a, p.id, b)],
  ["POST", "/api/batches/confirm", (s, a, b) => s.batch(a, b)],
  ["POST", "/api/reviews", (s, a, b) => s.review(a, b)],
  ["POST", "/api/schedule", (s, a, b) => s.changeSchedule(a, b)],
  ["POST", "/api/users", (s, a, b) => s.saveUser(a, null, b)],
  ["PATCH", "/api/users/:id", (s, a, b, p) => s.saveUser(a, p.id, b)],
  ["POST", "/api/admin/transfer", (s, a, b) => s.transfer(a, b)],
  ["POST", "/api/categories", (s, a, b) => s.saveCategory(a, null, b)],
  ["PATCH", "/api/categories/:id", (s, a, b, p) => s.saveCategory(a, p.id, b)],
];
export function findRoute(method, path) {
  for (const [m, template, fn] of routes) {
    if (m !== method) continue;
    const names = [];
    const pattern = template
      .split("/")
      .map((part) => {
        if (!part.startsWith(":")) return part;
        names.push(part.slice(1));
        return "([^/]+)";
      })
      .join("/");
    const match = new RegExp("^" + pattern + "$").exec(path);
    if (match)
      return {
        fn,
        params: Object.fromEntries(
          names.map((n, i) => [n, decodeURIComponent(match[i + 1])]),
        ),
      };
  }
  return null;
}
