export type User = {
  id: string;
  name: string;
  role: "WORKER" | "CHIEF";
  admin?: boolean;
  active: boolean;
  telegram_id?: string;
};
export type Mark = {
  userId: string;
  name: string;
  at: string;
  date?: string;
  reason?: string;
};
export type Doc = {
  id: string;
  title: string;
  categoryId: string;
  dueDate: string;
  status: string;
  version: number;
  createdBy: { userId: string; name: string };
  createdAt: string;
  updatedAt: string;
  ready: Mark | null;
  placement: Mark | null;
  confirmation: Mark | null;
  rejection: Mark | null;
  deleted: boolean;
  deadline: { kind: string; label: string };
};
export type Category = {
  id: string;
  name: string;
  position: number;
  hidden: boolean;
};
export type Period = {
  id: string;
  start: string;
  end: string;
  reviewDate: string;
  transition: boolean;
};
export type Audit = {
  id: string;
  seq: number;
  document_id: string | null;
  actor_id: string;
  actor_name: string;
  type: string;
  at: string;
  batch_id?: string;
  data: any;
};
export type State = {
  me: User;
  today: string;
  timeZone: string;
  documents: Doc[];
  categories: Category[];
  users: User[];
  periods: Period[];
  reviewRecords: any[];
  scheduleVersions: any[];
  audit: Audit[];
};
export const statuses: Record<string, string> = {
  IN_PROGRESS: "В работе",
  READY: "Оформлен, ожидает вложения в журнал",
  PLACED: "Вложен в журнал, ожидает подтверждения",
  CONFIRMED: "Вложение подтверждено",
  NEEDS_CORRECTION: "Требует исправления",
};
export const events: Record<string, string> = {
  CREATE: "Карточка создана",
  EDIT: "Поля изменены",
  READY: "Документ оформлен",
  PLACE: "Вложен в журнал",
  CONFIRM: "Вложение подтверждено",
  "PLACE-CONFIRM": "Вложен и подтверждён",
  REJECT: "Отметка отклонена",
  RETURN: "Возвращён в работу",
  REVOKE: "Подтверждение отозвано",
  DELETE: "Карточка удалена",
  REVIEW: "Проверка проведена",
  SCHEDULE: "Расписание изменено",
  USER: "Участник изменён",
  TRANSFER_ADMIN: "Администрирование передано",
  CATEGORY: "Категория изменена",
};
export function fmt(d: string) {
  return new Date(d + "T12:00:00Z").toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
export function stamp(d: string, zone: string) {
  return new Date(d).toLocaleString("ru-RU", {
    timeZone: zone,
    dateStyle: "short",
    timeStyle: "short",
  });
}
