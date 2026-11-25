export type User = {
  id: string;
  name: string;
  role: string;
  roleName?: string;
  permissions?: string[];
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
  readyDueDate?: string | null;
  topic?: string;
  recurring?: {
    ruleId: string;
    periodKey: string;
    start: string;
    end: string;
    topicLocked: boolean;
  } | null;
  items?: { id: string; label: string; ready: Mark | null }[];
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
  completed: boolean;
  deadline: { kind: string; label: string };
  readyDeadline?: { kind: string; label: string } | null;
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
export type Role = {
  id: string;
  name: string;
  permissions: string[];
  version: number;
};
export type State = {
  roles: Role[];
  me: User;
  today: string;
  timeZone: string;
  documents: Doc[];
  categories: Category[];
  users: User[];
  periods: Period[];
  reviewRecords: any[];
  scheduleVersions: any[];
  recurringRules: RecurringRule[];
  audit: Audit[];
};
export type RecurringRule = {
  id: string;
  category_id: string;
  title: string;
  cadence: "weekly" | "monthly" | "quarterly" | "callup";
  ready_day: number;
  placement_day: number;
  enabled: number;
  topic: string;
  topic_locked: number;
  item_count: number;
  version: number;
};
export const statuses: Record<string, string> = {
  IN_PROGRESS: "В работе",
  READY: "Документ оформлен",
  PLACED: "Вложен в журнал",
  CONFIRMED: "Вложение подтверждено",
  NEEDS_CORRECTION: "Требует исправления",
};
export const isSubmission = (doc: { categoryId?: string }) =>
  doc.categoryId === "category-12";
export const isTuesdayPlan = (doc: {
  categoryId?: string;
  title?: string;
  recurring?: { ruleId: string } | null;
}) =>
  doc.categoryId === "category-6" &&
  (doc.recurring?.ruleId === "inform-tuesday" ||
    doc.title?.split(" · ")[0].trim().toLocaleLowerCase("ru") ===
      "план проведения военно-политического информирования");
export const isReady = (doc: { status: string }) => doc.status === "READY";
export function readinessTerms(doc?: { categoryId?: string }) {
  if (doc?.categoryId === "category-6")
    return {
      status: "Лекторий проведен",
      imperative: "Провести",
      noun: "Проведение лектория",
      deadline: "Срок проведения",
      dateField: "Фактическая дата проведения",
      dateLabel: "Дата проведения",
      past: "Проведен",
      count: "Проведено",
      description: "Лектории проведены и ожидают вложения в журнал.",
      help: "Когда лекторий должен быть проведен. Вложение в журнал отмечается отдельно.",
    };
  if (doc?.categoryId === "category-8")
    return {
      status: "Доведена",
      imperative: "Довести",
      noun: "Доведение",
      deadline: "Срок доведения",
      dateField: "Фактическая дата доведения",
      dateLabel: "Дата доведения",
      past: "Доведена",
      count: "Доведено",
      description: "Информация доведена; документы ожидают вложения в журнал.",
      help: "Когда информация должна быть доведена. Вложение в журнал отмечается отдельно.",
    };
  return {
    status: "Документ оформлен",
    imperative: "Оформить",
    noun: "Оформление",
    deadline: "Срок оформления",
    dateField: "Фактическая дата оформления",
    dateLabel: "Дата оформления",
    past: "Оформлен",
    count: "Оформлено",
    description: "Документы оформлены и ожидают вложения в журнал или сдачи.",
    help: isSubmission(doc || {})
      ? "Когда рапорт должен быть подготовлен. Сдача отмечается отдельно."
      : "Когда документ должен быть подготовлен. Вложение отмечается отдельно.",
  };
}
export const readyHint = (doc: { categoryId?: string }) =>
  isSubmission(doc) ? "Ожидает сдачи" : "Ожидает вложения в журнал";
export function statusText(status: string, doc?: { categoryId?: string }) {
  if (status === "READY") return readinessTerms(doc).status;
  if (doc && isSubmission(doc)) {
    return (
      (
        {
          PLACED: "Сдан",
          CONFIRMED: "Сдача подтверждена",
        } as Record<string, string>
      )[status] || statuses[status]
    );
  }
  return statuses[status];
}
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
  ROLE: "Роль изменена",
  USER: "Участник изменён",
  TRANSFER_ADMIN: "Администрирование передано",
  CATEGORY: "Категория изменена",
  SUBDOCUMENT: "Лист беседы изменён",
  SUBDOCUMENTS: "Все листы беседы отмечены",
  COMMENT: "Комментарий добавлен",
  RENAME: "Название приведено к обычному регистру",
  RECURRENCE: "Расписание документов изменено",
};
export function eventText(event: Audit) {
  const doc = event.data.after || event.data.before;
  if (event.type === "READY") return statusText("READY", doc);
  if (doc && isSubmission(doc)) {
    return (
      (
        {
          PLACE: "Рапорт сдан",
          CONFIRM: "Сдача подтверждена",
          "PLACE-CONFIRM": "Рапорт сдан и подтверждён",
        } as Record<string, string>
      )[event.type] || events[event.type]
    );
  }
  return events[event.type];
}
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
