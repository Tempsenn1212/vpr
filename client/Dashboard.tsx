import { can } from "../shared/permissions.ts";
import React, { useState } from "react";
import { Search } from "lucide-react";
import {
  fmt,
  isReady,
  readyHint,
  readinessTerms,
  stamp,
  type Doc,
  type State,
} from "./types";
import { CategorySelect } from "./CategorySelect";
import { AppSelect } from "./AppSelect";
import { DocumentStatus } from "./DocumentStatus";
import { inMonth } from "./months";
export type DashboardFilter =
  | "all"
  | "working"
  | "ready"
  | "overdue"
  | "completed";
export function Dashboard({
  s,
  month,
  filter,
  setFilter,
  open,
  create,
}: {
  s: State;
  month: string;
  filter: DashboardFilter;
  setFilter: (f: DashboardFilter) => void;
  open: (d: Doc) => void;
  create: () => void;
}) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [sort, setSort] = useState("due");
  const all = s.documents.filter((d) => !d.deleted && inMonth(d, month));
  const matches = (d: Doc, f: DashboardFilter) =>
    f === "all" ||
    (f === "working" && d.status === "IN_PROGRESS") ||
    (f === "ready" && isReady(d)) ||
    (f === "completed" && d.completed) ||
    (f === "overdue" && d.deadline.kind === "overdue");
  const docs = all
    .filter(
      (d) =>
        matches(d, filter) &&
        (!category || d.categoryId === category) &&
        `${d.title} ${d.topic || ""}`
          .toLocaleLowerCase("ru")
          .includes(query.trim().toLocaleLowerCase("ru")),
    )
    .sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title, "ru")
        : (sort === "ready"
            ? (a.readyDueDate || a.dueDate).localeCompare(
                b.readyDueDate || b.dueDate,
              )
            : a.dueDate.localeCompare(b.dueDate)) ||
          a.title.localeCompare(b.title, "ru"),
    );
  const tabs: [DashboardFilter, string][] = [
    ["all", "Всего документов"],
    ["working", "В работе"],
    ["ready", readinessTerms({ categoryId: category }).status],
    [
      "overdue",
      category === "category-12"
        ? "Просрочено без сдачи"
        : "Просрочено без вложения",
    ],
    ["completed", "Завершено"],
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ОБЩИЙ УЧЁТ</div>
          <h1>Таблица документов</h1>
          <p>
            Оформление, проведение лекториев, доведение, вложение в журнал и
            сдача рапортов.
          </p>
        </div>
        {can(s.me, "documents.create") && (
          <button className="button" onClick={create}>
            Создать документ
          </button>
        )}
      </div>
      <div className="dashboard-tabs" role="group" aria-label="Фильтр таблицы">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            className={`tab-${id}${filter === id ? " active" : ""}`}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
            <b>{all.filter((d) => matches(d, id)).length}</b>
          </button>
        ))}
      </div>
      {filter === "ready" && (
        <p className="ready-filter-note">
          {category
            ? readinessTerms({ categoryId: category }).description
            : "Документы оформлены, лектории проведены или информация доведена; ожидают вложения в журнал или сдачи."}{" "}
          Срок предоставления учитывается отдельно.
        </p>
      )}
      <div className="filters">
        <div className="search">
          <Search size={18} />
          <input
            aria-label="Поиск документов в таблице"
            placeholder="Название или тема лектория"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <CategorySelect
          label="Категория в таблице"
          categories={s.categories}
          value={category}
          onChange={setCategory}
          allLabel="Все категории"
        />
        <AppSelect
          label="Порядок в таблице"
          value={sort}
          onChange={setSort}
          options={[
            { id: "due", name: "По сроку вложения / сдачи" },
            {
              id: "ready",
              name:
                category === "category-6"
                  ? "По сроку проведения"
                  : category === "category-8"
                    ? "По сроку доведения"
                    : "По сроку оформления",
            },
            { id: "title", name: "По названию" },
          ]}
        />
      </div>
      <p className="muted">
        Показано: {docs.length} из {all.length}. Месячная группа из 40 листов
        считается одним документом.
      </p>
      <div
        className="table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Таблица учёта документов"
      >
        <table className="documents-table">
          <thead>
            <tr>
              {[
                "Документ",
                "Категория",
                readinessTerms({ categoryId: category }).imperative + " до",
                category === "category-12" ? "Сдать до" : "Вложить / сдать до",
                "Статус",
                category === "category-12"
                  ? "Фактически сдан"
                  : "Вложен / сдан",
              ].map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className={isReady(d) ? "document-ready" : ""}>
                <td>
                  <button className="table-title" onClick={() => open(d)}>
                    {d.title}
                  </button>
                  {d.topic && (
                    <small className="table-topic">Тема: {d.topic}</small>
                  )}
                  {!!d.items?.length && (
                    <small>
                      Листы беседы: {d.items.filter((i) => i.ready).length}/
                      {d.items.length} оформлено
                    </small>
                  )}
                  {d.recurring && <small>По расписанию</small>}
                </td>
                <td>{s.categories.find((c) => c.id === d.categoryId)?.name}</td>
                <td>
                  <b>{d.readyDueDate ? fmt(d.readyDueDate) : "—"}</b>
                  {d.readyDeadline && (
                    <small className={"deadline " + d.readyDeadline.kind}>
                      {d.readyDeadline.label}
                    </small>
                  )}
                  {d.ready &&
                    !["IN_PROGRESS", "NEEDS_CORRECTION"].includes(d.status) && (
                      <small className="ready-date">
                        {readinessTerms(d).past}:{" "}
                        {d.ready.date
                          ? fmt(d.ready.date)
                          : stamp(d.ready.at, s.timeZone)}
                      </small>
                    )}
                </td>
                <td>
                  <b>{fmt(d.dueDate)}</b>
                  <small className={"deadline " + d.deadline.kind}>
                    {d.deadline.label}
                  </small>
                </td>
                <td>
                  <DocumentStatus status={d.status} doc={d} />
                  {isReady(d) && (
                    <small className="status-hint">{readyHint(d)}</small>
                  )}
                </td>
                <td>{d.placement ? fmt(d.placement.date!) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!docs.length && (
          <div className="empty">
            <h3>Документов по выбранным условиям нет</h3>
            <p>Измените фильтр или поисковый запрос.</p>
          </div>
        )}
      </div>
    </>
  );
}
