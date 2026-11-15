import React, { useState } from "react";
import { Search } from "lucide-react";
import { fmt, statuses, type Doc, type State } from "./types";
export type DashboardFilter = "all" | "overdue" | "completed";
export function Dashboard({
  s,
  filter,
  setFilter,
  open,
  create,
}: {
  s: State;
  filter: DashboardFilter;
  setFilter: (f: DashboardFilter) => void;
  open: (d: Doc) => void;
  create: () => void;
}) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [sort, setSort] = useState("due");
  const all = s.documents.filter((d) => !d.deleted);
  const matches = (d: Doc, f: DashboardFilter) =>
    f === "all" ||
    (f === "completed" ? d.completed : d.deadline.kind === "overdue");
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
    ["overdue", "Просрочено без вложения"],
    ["completed", "Завершено"],
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ОБЩИЙ УЧЁТ</div>
          <h1>Таблица документов</h1>
          <p>Оформление, вложение в журнал и выполнение месячных групп.</p>
        </div>
        <button className="button" onClick={create}>
          Создать документ
        </button>
      </div>
      <div className="dashboard-tabs" role="group" aria-label="Фильтр таблицы">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            className={filter === id ? "active" : ""}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
            <b>{all.filter((d) => matches(d, id)).length}</b>
          </button>
        ))}
      </div>
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
        <select
          aria-label="Категория в таблице"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Все категории</option>
          {s.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Порядок в таблице"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="due">По сроку вложения</option>
          <option value="ready">По сроку оформления</option>
          <option value="title">По названию</option>
        </select>
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
                "Оформить до",
                "Вложить до",
                "Статус",
                "Фактически вложен",
              ].map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
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
                </td>
                <td>
                  <b>{fmt(d.dueDate)}</b>
                  <small className={"deadline " + d.deadline.kind}>
                    {d.deadline.label}
                  </small>
                </td>
                <td>
                  <span className={"badge " + d.status.toLowerCase()}>
                    <span className="dot" />
                    {statuses[d.status]}
                  </span>
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
