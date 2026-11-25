export const permissionCatalog = [
  {
    id: "documents.create",
    label: "Создавать документы и копии",
    group: "Документы",
  },
  {
    id: "documents.edit",
    label: "Редактировать документы, темы и названия листов",
    group: "Документы",
  },
  { id: "documents.delete", label: "Удалять документы", group: "Документы" },
  {
    id: "documents.ready",
    label: "Отмечать оформление, проведение и доведение",
    group: "Документы",
  },
  {
    id: "documents.place",
    label: "Отмечать вложение в журнал и сдачу",
    group: "Документы",
  },
  {
    id: "documents.return",
    label: "Возвращать документы в работу",
    group: "Документы",
  },
  {
    id: "documents.confirm",
    label: "Подтверждать, отклонять и отзывать подтверждение",
    group: "Проверки и история",
  },
  {
    id: "reviews.view",
    label: "Просматривать периоды и результаты проверок",
    group: "Проверки и история",
  },
  {
    id: "reviews.create",
    label: "Фиксировать результаты проверки периода",
    group: "Проверки и история",
  },
  {
    id: "history.view",
    label: "Просматривать историю действий",
    group: "Проверки и история",
  },
  {
    id: "schedule.manage",
    label: "Настраивать расписания и периоды",
    group: "Управление",
  },
  {
    id: "categories.manage",
    label: "Добавлять и изменять категории",
    group: "Управление",
  },
  {
    id: "users.manage",
    label: "Добавлять участников и назначать доступные роли",
    group: "Управление доступом",
  },
  {
    id: "roles.manage",
    label: "Создавать роли и изменять их права",
    group: "Управление доступом",
  },
  {
    id: "backup.export",
    label: "Скачивать резервную копию всех данных",
    group: "Управление",
  },
] as const;
export type Permission = (typeof permissionCatalog)[number]["id"];
export const workerPermissions: Permission[] = [
  "documents.create",
  "documents.edit",
  "documents.delete",
  "documents.ready",
  "documents.place",
  "documents.return",
  "history.view",
  "reviews.view",
];
export const chiefPermissions: Permission[] = [
  ...workerPermissions,
  "documents.confirm",
  "reviews.create",
  "schedule.manage",
];
export const defaultRoles = [
  {
    id: "WORKER",
    name: "Работник",
    permissions: workerPermissions,
    version: 1,
  },
  { id: "CHIEF", name: "Начальник", permissions: chiefPermissions, version: 1 },
];
const ownerPermissions: Permission[] = [
  "roles.manage",
  "users.manage",
  "categories.manage",
  "schedule.manage",
  "backup.export",
  "history.view",
  "reviews.view",
];
export type AccessUser = {
  role?: string;
  admin?: boolean;
  permissions?: readonly string[];
};
export function can(
  user: AccessUser | null | undefined,
  permission: Permission,
): boolean {
  if (!user) return false;
  if (user.admin && ownerPermissions.includes(permission)) return true;
  const permissions =
    user.permissions ??
    defaultRoles.find((r) => r.id === user.role)?.permissions ??
    [];
  return permissions.includes(permission);
}
export function roleName(user: AccessUser & { roleName?: string }): string {
  return (
    user.roleName ||
    defaultRoles.find((r) => r.id === user.role)?.name ||
    "Роль"
  );
}
export function settingsAccess(user: AccessUser): boolean {
  return (
    [
      "roles.manage",
      "users.manage",
      "categories.manage",
      "schedule.manage",
      "backup.export",
    ] as const
  ).some((p) => can(user, p));
}
export function canAssignRole(
  user: AccessUser,
  role: { permissions: readonly string[] },
): boolean {
  return (
    !!user.admin ||
    can(user, "roles.manage") ||
    role.permissions.every((p) => can(user, p as Permission))
  );
}
