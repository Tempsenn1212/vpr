export const userRow = (r) =>
  r ? { ...r, admin: !!r.admin, active: !!r.active } : null;
