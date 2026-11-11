import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutGrid,
  ClipboardCheck,
  History,
  Settings,
  Plus,
  ArrowUpRight,
  ArrowLeft,
  FileText,
  Folder,
  Check,
  Clock,
  AlertCircle,
  ChevronRight,
  Search,
  X,
  Copy,
  Trash2,
  Sun,
  Moon,
  LogOut,
  CalendarDays,
  ShieldCheck,
  CheckCheck,
  RotateCcw,
  WifiOff,
  Filter,
} from "lucide-react";
import type { State, Doc, Category, Period, Audit, User } from "./types";
import { statuses, events, fmt, stamp } from "./types";
import { api, ApiError } from "./api";
import "./style.css";
declare global {
  interface Window {
    Telegram?: any;
  }
}
const tg = window.Telegram?.WebApp;
function Badge({ status }: { status: string }) {
  return (
    <span className={"badge " + status.toLowerCase()}>
      <span className="dot" />
      {statuses[status]}
    </span>
  );
}
function App() {
  const [data, setData] = useState<State | null>(null),
    [login, setLogin] = useState<User[] | null>(null),
    [denied, setDenied] = useState(""),
    [view, setView] = useState("home"),
    [category, setCategory] = useState(""),
    [modal, setModal] = useState<any>(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [online, setOnline] = useState(true),
    [busy, setBusy] = useState(false),
    [theme, setTheme] = useState(tg?.colorScheme || "light");
  const mounted = useRef(true),
    loading = useRef(false),
    epoch = useRef(0);
  const [loginBusy, setLoginBusy] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    tg?.ready();
    tg?.expand();
    const change = () => setTheme(tg.colorScheme);
    tg?.onEvent("themeChanged", change);
    return () => tg?.offEvent("themeChanged", change);
  }, []);
  const refresh = async () => {
    if (loading.current) return;
    loading.current = true;
    const e = epoch.current;
    try {
      const s = await api("/state");
      if (mounted.current && e === epoch.current) {
        setData(s);
        setOnline(true);
        setDenied("");
      }
    } catch (err) {
      if (e !== epoch.current) return;
      const ex = err as ApiError;
      if (ex.status === 401 || ex.status === 403) {
        setData(null);
        setDenied(ex.message);
      } else setOnline(false);
    } finally {
      loading.current = false;
    }
  };
  const init = async () => {
    try {
      const config = await api("/config");
      if (config.demo) setLogin(await api("/auth/demo-users"));
      if (tg?.initData)
        await api("/auth/telegram", { initData: tg.initData }, "POST", false);
      await refresh();
    } catch (e) {
      setDenied((e as Error).message);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void init();
    const timer = setInterval(() => void refresh(), 2000);
    const reconnect = () => void refresh();
    window.addEventListener("online", reconnect);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("online", reconnect);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  async function run(
    path: string,
    b: any,
    method = "POST",
    success = "Сохранено",
    close = true,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api(path, b, method);
      if (close) setModal(null);
      setNotice(success);
      await refresh();
      return r;
    } catch (e) {
      const ex = e as ApiError;
      setError(ex.message);
      if (ex.status === 409) {
        await refresh();
        setModal((m: any) =>
          ex.details?.document
            ? m?.type === "doc"
              ? { ...m, doc: ex.details.document }
              : m?.type === "form"
                ? { ...m, conflict: ex.details.document }
                : m
            : m,
        );
      }
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function signIn(id: string) {
    setLoginBusy(true);
    try {
      await api("/auth/demo", { userId: id }, "POST", false);
      epoch.current++;
      await refresh();
      setDenied("");
    } catch (e) {
      setDenied((e as Error).message);
    } finally {
      setLoginBusy(false);
    }
  }
  function navigate(v: string, c = "") {
    setView(v);
    setCategory(c);
    setError("");
    window.scrollTo(0, 0);
  }
  function openDoc(d: Doc) {
    setError("");
    setModal({ type: "doc", doc: d });
  }
  function form(d?: Doc, copy = false, c?: string) {
    setError("");
    setModal({ type: "form", doc: d, copy, categoryId: c || category });
  }
  if (!data)
    return (
      <div className="login-wrap">
        <div className="brand-mark">
          <FileText size={30} />
        </div>
        <h1>Учёт документации ВПР</h1>
        <p className="muted">Общий журнал документов и проверок</p>
        <div className="login-card">
          <ShieldCheck size={32} />
          <h2>{denied ? "Доступ не предоставлен" : "Подключаемся…"}</h2>
          <p>{denied || "Получаем данные с сервера"}</p>
          {login && (
            <>
              <div className="demo-note">
                Режим разработки · синтетические аккаунты
              </div>
              {login.map((u) => (
                <button
                  key={u.id}
                  disabled={loginBusy}
                  className="login-user"
                  onClick={() => signIn(u.id)}
                >
                  <span className="avatar">{u.name[0]}</span>
                  <span>
                    <b>{u.name}</b>
                    <small>
                      {u.role === "CHIEF" ? "Начальник" : "Работник"}
                      {u.admin ? " · Администратор" : ""}
                    </small>
                  </span>
                  <ChevronRight size={18} />
                </button>
              ))}
            </>
          )}
          <button className="button secondary" onClick={() => void init()}>
            Повторить подключение
          </button>
        </div>
      </div>
    );
  const s = data,
    me = s.me,
    chief = me.role === "CHIEF",
    docs = s.documents.filter((d) => !d.deleted),
    visibleCats = s.categories.filter((c) => !c.hidden),
    overdue = docs.filter((d) => d.deadline.kind === "overdue"),
    waiting = docs.filter((d) => d.status === "PLACED"),
    next = s.periods.find((p) => p.end >= s.today) || s.periods.at(-1),
    settingsAllowed = chief || me.admin;
  const selectedDoc =
    modal?.type === "doc"
      ? s.documents.find((d) => d.id === modal.doc.id)
      : null;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" onClick={() => navigate("home")}>
          <span className="brand-mark">
            <FileText size={23} />
          </span>
          <span>
            ВПР<span className="brand-sub">учёт документации</span>
          </span>
        </a>
        <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav>
          {[
            ["home", "Обзор", LayoutGrid],
            ["reviews", "Проверки", ClipboardCheck],
            ["history", "История", History],
            ...(settingsAllowed ? [["settings", "Управление", Settings]] : []),
          ].map(([id, label, Icon]: any) => (
            <button
              key={id}
              onClick={() => navigate(id)}
              className={view === id ? "active" : ""}
            >
              <Icon size={20} />
              <span>{label}</span>
              {id === "reviews" && waiting.length > 0 && (
                <em>{waiting.length}</em>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className={"dot " + (online ? "green" : "red")} />
            {online ? "Данные обновляются" : "Нет связи с сервером"}
          </div>
          <div className="user">
            <span className="avatar">{me.name[0]}</span>
            <div>
              <b>{me.name}</b>
              <small>
                {chief ? "Начальник" : "Работник"}
                {me.admin ? " · Админ" : ""}
              </small>
            </div>
          </div>
          <div className="utility">
            <button
              aria-label="Переключить тему"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <span>{s.timeZone}</span>
            {login && (
              <button
                aria-label="Выйти"
                onClick={async () => {
                  epoch.current++;
                  await api("/auth/logout", {}, "POST", false);
                  setData(null);
                  setDenied("Вы вышли из аккаунта");
                }}
              >
                <LogOut size={18} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            {view === "home"
              ? "Рабочее пространство"
              : view === "category"
                ? s.categories.find((c) => c.id === category)?.name
                : view === "reviews"
                  ? "Контроль и подтверждение"
                  : view === "history"
                    ? "Журнал действий"
                    : "Настройки приложения"}
          </span>
          <div>
            <CalendarDays size={16} />
            {fmt(s.today)}
            {login && (
              <>
                <span className="demo-pill">Демо</span>
                <button
                  aria-label="Сменить аккаунт"
                  onClick={async () => {
                    epoch.current++;
                    await api("/auth/logout", {}, "POST", false);
                    setData(null);
                    setDenied("Выберите тестовый аккаунт");
                  }}
                >
                  <LogOut size={15} />
                </button>
              </>
            )}
          </div>
        </header>
        {!online && (
          <div role="alert" className="offline">
            <WifiOff size={18} />
            Связь потеряна. Показаны последние полученные данные. Повторное
            подключение автоматически.
          </div>
        )}
        {notice && (
          <div role="status" className="toast success">
            <Check size={18} />
            {notice}
            <button aria-label="Закрыть" onClick={() => setNotice("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className="toast error">
            <AlertCircle size={18} />
            {error}
            <button aria-label="Закрыть" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        <div className="content">
          {view === "home" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ДОКУМЕНТЫ ПОД КОНТРОЛЕМ</div>
                  <h1>Обзор документации</h1>
                  <p>
                    {me.name} · {chief ? "Начальник" : "Работник"}
                    {me.admin ? " · Администратор" : ""}
                    <br />
                    Сроки, вложения и подтверждения — в одном месте.
                  </p>
                </div>
                <button
                  className="button"
                  onClick={() => form(undefined, false, visibleCats[0]?.id)}
                >
                  <Plus size={19} />
                  Создать документ
                </button>
              </div>
              <section className="stats">
                <Stat
                  icon={<FileText />}
                  label="Активных документов"
                  value={docs.length}
                  foot="Во всех категориях"
                />
                <Stat
                  icon={<AlertCircle />}
                  label="Просрочено без вложения"
                  value={overdue.length}
                  foot="Требуют внимания"
                  kind="red"
                />
                <Stat
                  icon={<Clock />}
                  label="Ожидают подтверждения"
                  value={waiting.length}
                  foot="Вложены в журнал"
                  kind="amber"
                />
              </section>
              {next && (
                <section className="review-banner">
                  <div className="calendar-icon">
                    <CalendarDays size={25} />
                  </div>
                  <div>
                    <span className="eyebrow">БЛИЖАЙШАЯ ПРОВЕРКА</span>
                    <h3>{fmt(next.end)}</h3>
                    <p>
                      Документы со сроком {fmt(next.start)} — {fmt(next.end)}
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    onClick={() => navigate("reviews")}
                  >
                    К проверке
                    <ArrowUpRight size={17} />
                  </button>
                </section>
              )}
              <div className="section-title">
                <h2>Категории документов</h2>
                <span>{visibleCats.length} категории</span>
              </div>
              <section className="category-grid">
                {visibleCats.map((c, i) => {
                  const list = docs.filter((d) => d.categoryId === c.id);
                  return (
                    <button
                      className="category-card"
                      key={c.id}
                      onClick={() => navigate("category", c.id)}
                    >
                      <div className="category-top">
                        <span className={"folder-icon tone-" + (i % 3)}>
                          <Folder size={27} />
                        </span>
                        <ArrowUpRight size={20} />
                      </div>
                      <h3>{c.name}</h3>
                      <p>{list.length} активных документов</p>
                      <div className="category-counts">
                        <span>
                          <i className="dot red" />
                          {
                            list.filter((d) => d.deadline.kind === "overdue")
                              .length
                          }{" "}
                          просрочено без вложения
                        </span>
                        <span>
                          <i className="dot amber" />
                          {
                            list.filter((d) => d.status === "PLACED").length
                          }{" "}
                          ожидают подтверждения
                        </span>
                      </div>
                    </button>
                  );
                })}
              </section>
              {!visibleCats.length && (
                <Empty text="Нет видимых категорий. Администратор может добавить категорию." />
              )}
              <div className="section-title">
                <h2>Требуют внимания</h2>
                <span>Ближайшие сроки первыми</span>
              </div>
              <DocumentList
                docs={[...overdue, ...waiting]
                  .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
                  .slice(0, 6)}
                s={s}
                onOpen={openDoc}
              />
              <p className="footnote">
                Счётчики отражают разные условия и могут пересекаться.
                Оформление не закрывает срок предоставления.
              </p>
            </>
          )}
          {view === "category" && (
            <CategoryView
              s={s}
              id={category}
              onOpen={openDoc}
              onCreate={() => form(undefined, false, category)}
              back={() => navigate("home")}
            />
          )}
          {view === "reviews" && (
            <Reviews
              s={s}
              busy={busy}
              open={openDoc}
              run={run}
              showModal={(m: any) => {
                setError("");
                setModal(m);
              }}
            />
          )}
          {view === "history" && <HistoryView s={s} open={openDoc} />}
          {view === "settings" && settingsAllowed && (
            <SettingsView s={s} run={run} busy={busy} setError={setError} />
          )}
        </div>
      </main>
      {modal && (
        <div className="modal-shade" onClick={() => !busy && setModal(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal.type === "form"
                ? "Форма документа"
                : modal.type === "doc"
                  ? "Карточка документа"
                  : "Подтверждение действия"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="Закрыть окно"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              <X />
            </button>
            {error && (
              <div role="alert" className="inline-error">
                {error}
              </div>
            )}
            {modal.type === "form" && (
              <DocumentForm
                key={
                  (modal.doc?.id || "new") +
                  String(modal.copy) +
                  String(modal.doc?.version || 0)
                }
                s={s}
                modal={modal}
                busy={busy}
                reload={() =>
                  setModal({ ...modal, doc: modal.conflict, conflict: null })
                }
                submit={(b: any) =>
                  run(
                    modal.doc && !modal.copy
                      ? "/documents/" + modal.doc.id
                      : "/documents",
                    b,
                    modal.doc && !modal.copy ? "PATCH" : "POST",
                    "Карточка сохранена",
                  )
                }
              />
            )}
            {modal.type === "doc" && (
              <DocumentDetail
                doc={selectedDoc || modal.doc}
                s={s}
                busy={busy}
                edit={(d: Doc) => form(d)}
                copy={(d: Doc) => form(d, true)}
                action={(d: Doc, a: string) => {
                  setError("");
                  setModal({ type: "action", doc: d, action: a });
                }}
              />
            )}
            {modal.type === "action" && (
              <ActionForm
                modal={modal}
                s={s}
                busy={busy}
                submit={(b: any) =>
                  run(
                    "/documents/" +
                      modal.doc.id +
                      (modal.action === "delete"
                        ? ""
                        : "/actions/" + modal.action),
                    { version: modal.doc.version, ...b },
                    modal.action === "delete" ? "DELETE" : "POST",
                    modal.action === "delete"
                      ? "Карточка удалена"
                      : "Действие сохранено",
                  )
                }
              />
            )}
            {modal.type === "batch" && (
              <>
                <div className="eyebrow">МАССОВОЕ ПОДТВЕРЖДЕНИЕ</div>
                <h2>Подтвердить {modal.items.length} документов?</h2>
                <p>
                  Период: {fmt(modal.period.start)} — {fmt(modal.period.end)}
                </p>
                <p>
                  Область:{" "}
                  <b>
                    {modal.categoryId === "ALL"
                      ? "Все категории"
                      : s.categories.find((c) => c.id === modal.categoryId)
                          ?.name}
                  </b>
                </p>
                <p className="muted">
                  Вернитесь к списку, чтобы исключить карточки. Сервер повторно
                  проверит статус, область и версии.
                </p>
                <button
                  className="button"
                  disabled={busy}
                  onClick={async () => {
                    const r = await run(
                      "/batches/confirm",
                      {
                        periodId: modal.period.id,
                        categoryId: modal.categoryId,
                        items: modal.items,
                      },
                      "POST",
                      "Операция завершена",
                    );
                    if (r)
                      setNotice(
                        `Подтверждено: ${r.confirmed} · Пропущено: ${r.skipped} · Конфликт: ${r.conflicts}`,
                      );
                  }}
                >
                  <CheckCheck size={18} />
                  Подтвердить выбранные
                </button>
              </>
            )}
            {modal.type === "review" && (
              <>
                <h2>Зафиксировать проверку?</h2>
                <p>
                  {fmt(modal.period.start)} — {fmt(modal.period.end)}
                </p>
                <p>
                  Сохранятся автор, время и снимок всех карточек периода с
                  итогами. Статусы документов останутся прежними.
                </p>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    run(
                      "/reviews",
                      { periodId: modal.period.id },
                      "POST",
                      "Проверка зафиксирована",
                    )
                  }
                >
                  Проверка проведена
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Stat({ icon, label, value, foot, kind = "blue" }: any) {
  return (
    <div className="stat">
      <span className={"stat-icon " + kind}>{icon}</span>
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
      <small>{foot}</small>
    </div>
  );
}
function Empty({ text = "Документов пока нет" }: { text?: string }) {
  return (
    <div className="empty">
      <Folder size={30} />
      <h3>{text}</h3>
      <p>Новые карточки появятся здесь после сохранения.</p>
    </div>
  );
}
function DocumentList({
  docs,
  s,
  onOpen,
  select,
  selected,
}: {
  docs: Doc[];
  s: State;
  onOpen: (d: Doc) => void;
  select?: (d: Doc) => void;
  selected?: Map<string, number>;
}) {
  return (
    <div className="document-list">
      {!docs.length && <Empty />}
      {docs.map((d) => (
        <div className="document-row" key={d.id}>
          {select && (
            <input
              aria-label={"Выбрать " + d.title}
              type="checkbox"
              disabled={d.status !== "PLACED"}
              checked={selected?.has(d.id) || false}
              onChange={() => select(d)}
            />
          )}
          <button className="doc-link" onClick={() => onOpen(d)}>
            <span className="doc-icon">
              <FileText size={20} />
            </span>
            <span className="doc-main">
              <b>{d.title}</b>
              <small>
                {s.categories.find((c) => c.id === d.categoryId)?.name} · Срок{" "}
                {fmt(d.dueDate)}
              </small>
              <span className={"deadline " + d.deadline.kind}>
                {d.deadline.label}
              </span>
            </span>
            <span className="doc-status">
              <Badge status={d.status} />
              <ChevronRight size={17} />
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
function CategoryView({ s, id, onOpen, onCreate, back }: any) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [due, setDue] = useState("");
  const c = s.categories.find((c: Category) => c.id === id);
  const docs = s.documents.filter(
    (d: Doc) =>
      !d.deleted &&
      d.categoryId === id &&
      d.title.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")) &&
      (!status || d.status === status) &&
      (!due || d.deadline.kind === due),
  );
  return (
    <>
      <button className="back" onClick={back}>
        <ArrowLeft size={16} />
        Все категории
      </button>
      <div className="page-heading">
        <div>
          <div className="eyebrow">КАТЕГОРИЯ ДОКУМЕНТОВ</div>
          <h1>{c?.name}</h1>
          <p>Общая работа · {docs.length} документов в списке</p>
        </div>
        <button className="button" onClick={onCreate}>
          <Plus size={18} />
          Создать документ
        </button>
      </div>
      <div className="filters">
        <label className="search">
          <Search size={18} />
          <input
            placeholder="Поиск по названию"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="Статус"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Все статусы</option>
          {Object.entries(statuses).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          aria-label="Срок"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        >
          <option value="">Все сроки</option>
          <option value="overdue">Просрочено без вложения</option>
          <option value="today">Срок сегодня</option>
          <option value="future">Срок впереди</option>
          <option value="late">Вложено с опозданием</option>
          <option value="on-time">Вложено в срок</option>
        </select>
      </div>
      <DocumentList docs={docs} s={s} onOpen={onOpen} />
    </>
  );
}
function DocumentForm({ s, modal, busy, reload, submit }: any) {
  const old: Doc | undefined = modal.doc,
    editing = old && !modal.copy;
  const [title, setTitle] = useState(old?.title || ""),
    [due, setDue] = useState(editing ? old.dueDate : ""),
    [cat, setCat] = useState(
      old?.categoryId ||
        modal.categoryId ||
        s.categories.find((c: Category) => !c.hidden)?.id ||
        "",
    ),
    [placementDate, setPlacement] = useState(old?.placement?.date || ""),
    [ack, setAck] = useState(false),
    [attempt, setAttempt] = useState(false);
  const invalidTitle = !title.trim() || title.trim().length > 200;
  const changed =
    editing &&
    (title.trim() !== old.title ||
      due !== old.dueDate ||
      cat !== old.categoryId ||
      placementDate !== (old.placement?.date || ""));
  const reset = changed && old.status === "CONFIRMED";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setAttempt(true);
        if (invalidTitle || !due || !cat || (reset && !ack)) return;
        submit({
          title: title.trim(),
          dueDate: due,
          categoryId: cat,
          ...(editing
            ? {
                version: old.version,
                ...(old.placement ? { placementDate } : {}),
                acknowledgeReset: ack,
              }
            : {}),
        });
      }}
    >
      <div className="eyebrow">КАРТОЧКА ДОКУМЕНТА</div>
      <h2>
        {modal.copy
          ? "Создать копию"
          : editing
            ? "Редактировать документ"
            : "Новый документ"}
      </h2>
      {modal.conflict && (
        <div className="warning">
          <div>
            Актуальная версия {modal.conflict.version}: «{modal.conflict.title}
            », срок {fmt(modal.conflict.dueDate)}. Ваши несохранённые поля пока
            остаются в форме.
            <button type="button" className="text-link" onClick={reload}>
              Загрузить актуальную карточку
            </button>
          </div>
        </div>
      )}
      {modal.copy && (
        <p className="muted">
          Выберите новый срок. Отметки и история исходной карточки не
          копируются.
        </p>
      )}
      <label className="field">
        Название
        <textarea
          aria-label="Название"
          maxLength={200}
          rows={3}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <small>{title.length}/200</small>
        {attempt && invalidTitle && (
          <span className="field-error">Введите название (1–200 символов)</span>
        )}
      </label>
      <label className="field">
        Срок предоставления
        <input
          type="date"
          min="1900-01-01"
          max="2200-12-31"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        {attempt && !due && <span className="field-error">Укажите срок</span>}
      </label>
      <label className="field">
        Категория
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          {s.categories
            .filter((c: Category) => !c.hidden || c.id === old?.categoryId)
            .map((c: Category) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.hidden ? " (скрыта)" : ""}
              </option>
            ))}
        </select>
      </label>
      {editing && old.placement && (
        <label className="field">
          Фактическая дата вложения
          <input
            type="date"
            min="1900-01-01"
            max={s.today}
            value={placementDate}
            onChange={(e) => setPlacement(e.target.value)}
          />
        </label>
      )}
      {reset && (
        <label className="warning">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          При сохранении подтверждение будет снято, карточка вернётся к ожиданию
          подтверждения. История сохранится.
        </label>
      )}
      <button disabled={busy} className="button full" type="submit">
        {busy ? "Сохраняем…" : "Сохранить документ"}
      </button>
    </form>
  );
}
function DocumentDetail({ doc: d, s, busy, edit, copy, action }: any) {
  const chief = s.me.role === "CHIEF";
  const mark = (label: string, m: any) => (
    <div className="mark">
      <b>{label}</b>
      <span>
        {m.name} · {stamp(m.at, s.timeZone)}
      </span>
      {m.date && <span>Фактическая дата: {fmt(m.date)}</span>}
      {m.reason && <span className="field-error">{m.reason}</span>}
    </div>
  );
  return (
    <>
      <div className="eyebrow">
        ДОКУМЕНТ · {d.id.slice(0, 8)} · ВЕРСИЯ {d.version}
      </div>
      <h2>{d.title}</h2>
      {d.deleted && (
        <div className="warning">Карточка удалена · только просмотр</div>
      )}
      <Badge status={d.status} />
      <div className="detail-dates">
        <div>
          <small>Срок предоставления</small>
          <b>{fmt(d.dueDate)}</b>
        </div>
        <div>
          <small>Категория</small>
          <b>
            {s.categories.find((c: Category) => c.id === d.categoryId)?.name}
          </b>
        </div>
      </div>
      {d.deadline && (
        <p className={"deadline " + d.deadline.kind}>{d.deadline.label}</p>
      )}
      {d.status === "PLACED" && (
        <p className="warning">
          Ожидает подтверждения. Фактическая дата указана участником.
        </p>
      )}
      <div className="marks">
        {mark("Создал", { ...d.createdBy, at: d.createdAt })}
        {d.ready && mark("Документ оформлен", d.ready)}
        {d.placement && mark("Вложение отмечено", d.placement)}
        {d.confirmation && mark("Подтверждено", d.confirmation)}
        {d.rejection && mark("Отметка отклонена", d.rejection)}
        <small className="muted">
          Последнее изменение: {stamp(d.updatedAt, s.timeZone)}
        </small>
      </div>
      {!d.deleted && (
        <>
          <div className="action-grid">
            {["IN_PROGRESS", "NEEDS_CORRECTION"].includes(d.status) && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => action(d, "ready")}
              >
                <Check />
                Документ оформлен
              </button>
            )}
            {["IN_PROGRESS", "READY", "NEEDS_CORRECTION"].includes(
              d.status,
            ) && (
              <>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => action(d, "place")}
                >
                  <Folder />
                  Вложен в журнал
                </button>
                {chief && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => action(d, "place-confirm")}
                  >
                    <CheckCheck />
                    Вложен и подтверждён
                  </button>
                )}
              </>
            )}
            {chief && d.status === "PLACED" && (
              <>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => action(d, "confirm")}
                >
                  <ShieldCheck />
                  Подтвердить вложение
                </button>
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={() => action(d, "reject")}
                >
                  Отклонить отметку
                </button>
              </>
            )}
            {chief && d.status === "CONFIRMED" && (
              <button
                className="button secondary"
                onClick={() => action(d, "revoke")}
              >
                Отозвать подтверждение
              </button>
            )}
            {d.status !== "IN_PROGRESS" && (
              <button
                className="button secondary"
                onClick={() => action(d, "return")}
              >
                <RotateCcw />
                Вернуть в работу
              </button>
            )}
          </div>
          <div className="small-actions">
            <button onClick={() => edit(d)}>Редактировать</button>
            <button onClick={() => copy(d)}>
              <Copy size={16} />
              Создать копию
            </button>
            <button className="danger-text" onClick={() => action(d, "delete")}>
              <Trash2 size={16} />
              Удалить
            </button>
          </div>
        </>
      )}
      <h3>История карточки</h3>
      <AuditList
        eventsList={s.audit.filter((e: Audit) => e.document_id === d.id)}
        s={s}
      />
    </>
  );
}
function ActionForm({ modal, s, busy, submit }: any) {
  const { doc: d, action: a } = modal;
  const [date, setDate] = useState(s.today),
    [reason, setReason] = useState(""),
    [confirm, setConfirm] = useState(false);
  const reasons = ["reject", "return", "revoke"].includes(a),
    placement = ["place", "place-confirm"].includes(a),
    confirmation = ["return", "delete"].includes(a);
  const labels: any = {
    ready: "Документ оформлен",
    place: "Вложен в журнал",
    "place-confirm": "Вложен в журнал и подтверждён",
    confirm: "Подтвердить вложение",
    reject: "Отклонить отметку",
    return: "Вернуть в работу",
    revoke: "Отозвать подтверждение",
    delete: "Удалить карточку",
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit({
          ...(placement ? { date } : {}),
          ...(reasons ? { reason } : {}),
          ...(confirmation ? { confirmed: confirm } : {}),
        });
      }}
    >
      <div className="eyebrow">ИЗМЕНЕНИЕ КАРТОЧКИ</div>
      <h2>{labels[a]}</h2>
      <p>{d.title}</p>
      {placement && (
        <label className="field">
          Фактическая дата вложения
          <input
            required
            type="date"
            min="1900-01-01"
            max={s.today}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <small>
            Можно указать прошлую дату. Время действия фиксируется сервером
            отдельно.
          </small>
        </label>
      )}
      {reasons && (
        <label className="field">
          Причина
          <textarea
            required
            maxLength={1000}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}
      {confirmation && (
        <label className="warning">
          <input
            required
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
          {a === "delete"
            ? "Подтверждаю удаление из активных списков. История сохранится."
            : "Подтверждаю очистку действующих отметок. История сохранится."}
        </label>
      )}
      <button
        className="button full"
        disabled={
          busy || (reasons && !reason.trim()) || (confirmation && !confirm)
        }
      >
        {busy ? "Сохраняем…" : labels[a]}
      </button>
    </form>
  );
}
function Reviews({ s, busy, open, run, showModal }: any) {
  const [periodId, setPeriod] = useState(
      s.periods.find((p: Period) => p.end >= s.today)?.id ||
        s.periods.at(-1)?.id ||
        "",
    ),
    [cat, setCat] = useState("ALL"),
    [selected, setSelected] = useState<Map<string, number>>(new Map());
  const p: Period | undefined =
    s.periods.find((p: Period) => p.id === periodId) ||
    s.periods.find((p: Period) => p.end >= s.today);
  const chief = s.me.role === "CHIEF";
  const list: Doc[] = p
    ? s.documents.filter(
        (d: Doc) =>
          !d.deleted &&
          d.dueDate >= p.start &&
          d.dueDate <= p.end &&
          (cat === "ALL" || cat === d.categoryId),
      )
    : [];
  const waiting = list.filter((d) => d.status === "PLACED");
  const past = s.documents.filter(
    (d: Doc) =>
      !d.deleted && d.status !== "CONFIRMED" && p && d.dueDate < p.start,
  );
  const records = s.reviewRecords.filter((r: any) => r.period_id === p?.id);
  const missed = s.periods.filter(
    (p: Period) =>
      p.end < s.today &&
      !s.reviewRecords.some((r: any) => r.period_id === p.id),
  );
  function scope(id: string, c: string) {
    setPeriod(id);
    setCat(c);
    setSelected(new Map());
  }
  function toggle(d: Doc) {
    setSelected((old) => {
      const n = new Map(old);
      if (n.has(d.id)) n.delete(d.id);
      else n.set(d.id, d.version);
      return n;
    });
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">КОНТРОЛЬ ВЫПОЛНЕНИЯ</div>
          <h1>Проверки документов</h1>
          <p>Проверяйте вложения и фиксируйте итоги периода.</p>
        </div>
        {chief && p && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => showModal({ type: "review", period: p })}
          >
            <ClipboardCheck size={18} />
            Проверка проведена
          </button>
        )}
      </div>
      {missed.length > 0 && (
        <div className="warning">
          <AlertCircle size={18} />
          Не проведено проверок после плановой даты: {missed.length}. Периоды
          доступны в списке.
        </div>
      )}
      <div className="filters">
        <label className="field compact">
          Проверяемый период
          <select
            aria-label="Период"
            value={p?.id || ""}
            onChange={(e) => scope(e.target.value, cat)}
          >
            {s.periods.map((p: Period) => (
              <option key={p.id} value={p.id}>
                {fmt(p.start)} — {fmt(p.end)}
                {p.transition ? " · переходный" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field compact">
          Область выбора
          <select
            aria-label="Категория проверки"
            value={cat}
            onChange={(e) => scope(periodId, e.target.value)}
          >
            <option value="ALL">Все категории</option>
            {s.categories.map((c: Category) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!p ? (
        <Empty text="Первый период ещё не настроен" />
      ) : (
        <>
          <div className="review-meta">
            <CalendarDays size={18} />
            <b>Дата проверки: {fmt(p.end)}</b>
            <span>
              {records.length
                ? "Проверка зафиксирована"
                : "Проверка пока не проведена"}
            </span>
            {p.transition && (
              <span className="demo-pill">Переходный период</span>
            )}
          </div>
          <div className="status-summary">
            {Object.entries(statuses).map(([k, v]) => (
              <div key={k}>
                <b>{list.filter((d) => d.status === k).length}</b>
                <span>{v}</span>
              </div>
            ))}
          </div>
          {chief && (
            <div className="batch-toolbar">
              <label>
                <input
                  type="checkbox"
                  aria-label="Выбрать все ожидающие"
                  checked={
                    waiting.length > 0 &&
                    waiting.every((d) => selected.has(d.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? new Map(waiting.map((d) => [d.id, d.version]))
                        : new Map(),
                    )
                  }
                />
                Все ожидающие в этой области ({waiting.length})
              </label>
              <button
                className="button"
                disabled={busy || !selected.size}
                onClick={() =>
                  showModal({
                    type: "batch",
                    period: p,
                    categoryId: cat,
                    items: [...selected].map(([id, version]) => ({
                      id,
                      version,
                    })),
                  })
                }
              >
                Подтвердить выбранные ({selected.size})
              </button>
            </div>
          )}
          {[...selected].some(
            ([id, v]) =>
              s.documents.find((d: Doc) => d.id === id)?.version !== v,
          ) && (
            <p className="warning">
              Выбранные карточки изменились. Сервер пропустит конфликты;
              проверьте список перед повторным выбором.
            </p>
          )}
          <DocumentList
            docs={list}
            s={s}
            onOpen={open}
            select={chief ? toggle : undefined}
            selected={selected}
          />
          <div className="section-title">
            <h2>Незавершённые прошлых периодов</h2>
            <span>{past.length} документов · отдельная обработка</span>
          </div>
          <p className="muted">
            Все сроки до {fmt(p.start)}, включая документы до первого периода.
            Они не входят в массовое действие выше.
          </p>
          <DocumentList docs={past} s={s} onOpen={open} />
          <div className="section-title">
            <h2>Сохранённые результаты проверок</h2>
          </div>
          <p className="muted">
            Снимки неизменны. Текущие карточки могут отличаться от состояния на
            момент проверки.
          </p>
          {!s.reviewRecords.length && (
            <p className="muted">Проведённых проверок пока нет.</p>
          )}
          {s.reviewRecords.map((r: any) => (
            <details className="snapshot" key={r.id}>
              <summary>
                {fmt(r.snapshot.period.start)} — {fmt(r.snapshot.period.end)} ·{" "}
                {r.actor_name} · {stamp(r.at, s.timeZone)}
              </summary>
              <p>На момент проверки: {r.snapshot.summary.total} документов.</p>
              <ul>
                {Object.entries(statuses).map(([k, v]) => (
                  <li key={k}>
                    {v}: {r.snapshot.summary[k]}
                  </li>
                ))}
              </ul>
              {r.snapshot.documents.map((d: Doc) => (
                <div className="snapshot-doc" key={d.id}>
                  <b>{d.title}</b>
                  <span>
                    Версия {d.version} · Срок {fmt(d.dueDate)}
                  </span>
                  <Badge status={d.status} />
                </div>
              ))}
            </details>
          ))}
        </>
      )}
    </>
  );
}
function AuditList({
  eventsList,
  s,
  open,
}: {
  eventsList: Audit[];
  s: State;
  open?: (d: Doc) => void;
}) {
  return (
    <div className="audit-list">
      {!eventsList.length && (
        <p className="muted">Нет событий для выбранных фильтров.</p>
      )}
      {eventsList.map((e) => {
        const before = e.data.before,
          after = e.data.after;
        const d = s.documents.find((d) => d.id === e.document_id);
        return (
          <div className="audit-event" key={e.id}>
            <span className="timeline-dot" />
            <div>
              <b>{events[e.type] || e.type}</b>
              {open && d && (
                <button className="text-link" onClick={() => open(d)}>
                  {d.title}
                  {d.deleted ? " · удалён" : ""}
                </button>
              )}
              <small>
                {e.actor_name} · {stamp(e.at, s.timeZone)}
              </small>
              {e.data.reason && <p>Причина: {e.data.reason}</p>}
              {e.batch_id && <small>Общая операция: {e.batch_id}</small>}
              {before && after && (
                <div className="diff">
                  {["title", "categoryId", "dueDate", "status"]
                    .filter((k) => before[k] !== after[k])
                    .map((k) => (
                      <p key={k}>
                        {
                          (
                            {
                              title: "Название",
                              categoryId: "Категория",
                              dueDate: "Срок",
                              status: "Статус",
                            } as any
                          )[k]
                        }
                        :{" "}
                        <del>
                          {k === "status"
                            ? statuses[before[k]]
                            : k === "categoryId"
                              ? e.data.categoryNames?.[before[k]] ||
                                s.categories.find((c) => c.id === before[k])
                                  ?.name ||
                                before[k]
                              : before[k]}
                        </del>{" "}
                        →{" "}
                        <span>
                          {k === "status"
                            ? statuses[after[k]]
                            : k === "categoryId"
                              ? e.data.categoryNames?.[after[k]] ||
                                s.categories.find((c) => c.id === after[k])
                                  ?.name ||
                                after[k]
                              : after[k]}
                        </span>
                      </p>
                    ))}
                  {before.placement?.date !== after.placement?.date && (
                    <p>
                      Дата вложения: {before.placement?.date || "—"} →{" "}
                      {after.placement?.date || "—"}
                    </p>
                  )}
                </div>
              )}
              <details>
                <summary>Сведения события</summary>
                <pre>{JSON.stringify(e.data, null, 2)}</pre>
              </details>
            </div>
          </div>
        );
      })}
    </div>
  );
}
function HistoryView({ s, open }: any) {
  const [doc, setDoc] = useState(""),
    [actor, setActor] = useState(""),
    [type, setType] = useState(""),
    [deleted, setDeleted] = useState(false);
  const list = s.audit.filter(
    (e: Audit) =>
      (!doc || e.document_id === doc) &&
      (!actor || e.actor_id === actor) &&
      (!type || e.type === type) &&
      (!deleted ||
        s.documents.some((d: Doc) => d.id === e.document_id && d.deleted)),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ПРОЗРАЧНАЯ СОВМЕСТНАЯ РАБОТА</div>
          <h1>История действий</h1>
          <p>Изменения и отметки всех участников, включая отключённых.</p>
        </div>
      </div>
      <div className="filters">
        <select
          aria-label="Карточка в истории"
          value={doc}
          onChange={(e) => setDoc(e.target.value)}
        >
          <option value="">Все карточки и настройки</option>
          {s.documents.map((d: Doc) => (
            <option key={d.id} value={d.id}>
              {d.title}
              {d.deleted ? " · удалён" : ""}
            </option>
          ))}
        </select>
        <select
          aria-label="Участник в истории"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        >
          <option value="">Все участники</option>
          {s.users.map((u: User) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Тип события"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">Все события</option>
          {Object.entries(events).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={deleted}
            onChange={(e) => setDeleted(e.target.checked)}
          />
          Только удалённые
        </label>
      </div>
      <div className="panel">
        <AuditList eventsList={list} s={s} open={open} />
      </div>
    </>
  );
}
function SettingsView({ s, run, busy, setError }: any) {
  const admin = s.me.admin;
  const current = s.scheduleVersions.at(-1);
  const [anchor, setAnchor] = useState(current.anchor),
    [interval, setIntervalValue] = useState(current.interval),
    [preview, setPreview] = useState<any>(null),
    [userDraft, setUser] = useState<any>(null),
    [catDraft, setCat] = useState<any>(null),
    [target, setTarget] = useState(""),
    [transferAck, setTransferAck] = useState(false);
  async function previewSchedule() {
    try {
      setError("");
      setPreview(
        await api("/schedule/preview", { anchor, interval }, "POST", false),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">УПРАВЛЕНИЕ ПРИЛОЖЕНИЕМ</div>
          <h1>Настройки</h1>
          <p>Расписание проверок{admin ? ", участники и категории" : ""}.</p>
        </div>
      </div>
      <section className="panel">
        <div className="section-title">
          <h2>Расписание проверок</h2>
          <CalendarDays size={21} />
        </div>
        <p className="muted">
          Новые настройки вступают в силу после текущего периода. До первого
          периода можно заменить начальные настройки целиком.
        </p>
        <div className="form-row">
          <label className="field">
            Дата начала отсчёта
            <input
              type="date"
              value={anchor}
              min="1900-01-01"
              max="2200-12-31"
              onChange={(e) => {
                setAnchor(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <label className="field">
            Интервал, календарных дней
            <input
              type="number"
              min={1}
              max={3660}
              step={1}
              value={interval}
              onChange={(e) => {
                setIntervalValue(Number(e.target.value));
                setPreview(null);
              }}
            />
          </label>
        </div>
        <button className="button secondary" onClick={previewSchedule}>
          Рассчитать ближайшие даты
        </button>
        {preview && (
          <div className="schedule-preview">
            <h3>Предварительный расчёт</h3>
            {preview.periods.map((p: Period) => (
              <p key={p.id}>
                {fmt(p.start)} — {fmt(p.end)}
                {p.transition && <b> · Переходный период</b>}
              </p>
            ))}
            <button
              className="button"
              disabled={busy}
              onClick={async () => {
                const r = await run(
                  "/schedule",
                  { anchor, interval, expectedVersion: current.id },
                  "POST",
                  "Расписание сохранено",
                  false,
                );
                if (r) setPreview(null);
              }}
            >
              Сохранить расписание
            </button>
          </div>
        )}
        <details>
          <summary>Версии расписания</summary>
          {s.scheduleVersions.map((v: any) => (
            <p key={v.id}>
              С {fmt(v.effectiveStart)} · отсчёт {fmt(v.anchor)} · {v.interval}{" "}
              дней · {stamp(v.at, s.timeZone)}
            </p>
          ))}
        </details>
      </section>
      {admin && (
        <>
          <section className="panel">
            <div className="section-title">
              <h2>Участники и роли</h2>
              <button
                className="button secondary"
                onClick={() =>
                  setUser({
                    name: "",
                    telegramId: "",
                    role: "WORKER",
                    active: true,
                  })
                }
              >
                <Plus size={17} />
                Добавить
              </button>
            </div>
            {s.users.map((u: User) => (
              <div className="management-row" key={u.id}>
                <div>
                  <b>{u.name}</b>
                  <small>
                    Telegram ID: {u.telegram_id} ·{" "}
                    {u.role === "CHIEF" ? "Начальник" : "Работник"}
                    {u.admin ? " · Администратор" : ""}
                    {!u.active ? " · Отключён" : ""}
                  </small>
                </div>
                <button
                  className="text-link"
                  onClick={() => setUser({ ...u, telegramId: u.telegram_id })}
                >
                  Изменить
                </button>
              </div>
            ))}
            {userDraft && (
              <form
                className="inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await run(
                    "/users" + (userDraft.id ? "/" + userDraft.id : ""),
                    userDraft,
                    userDraft.id ? "PATCH" : "POST",
                    "Участник сохранён",
                    false,
                  );
                  if (r) setUser(null);
                }}
              >
                <label className="field">
                  Имя
                  <input
                    required
                    maxLength={100}
                    value={userDraft.name}
                    onChange={(e) =>
                      setUser({ ...userDraft, name: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  Telegram ID
                  <input
                    required
                    inputMode="numeric"
                    pattern="[0-9]{1,16}"
                    value={userDraft.telegramId}
                    onChange={(e) =>
                      setUser({ ...userDraft, telegramId: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  Рабочая роль
                  <select
                    value={userDraft.role}
                    onChange={(e) =>
                      setUser({ ...userDraft, role: e.target.value })
                    }
                  >
                    <option value="WORKER">Работник</option>
                    <option value="CHIEF">Начальник</option>
                  </select>
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={userDraft.active}
                    onChange={(e) =>
                      setUser({ ...userDraft, active: e.target.checked })
                    }
                  />
                  Доступ включён
                </label>
                <div className="small-actions">
                  <button className="button" disabled={busy}>
                    Сохранить участника
                  </button>
                  <button type="button" onClick={() => setUser(null)}>
                    Отмена
                  </button>
                </div>
              </form>
            )}
          </section>
          <section className="panel">
            <div className="section-title">
              <h2>Категории</h2>
              <button
                className="button secondary"
                onClick={() =>
                  setCat({
                    name: "",
                    position: s.categories.length + 1,
                    hidden: false,
                  })
                }
              >
                <Plus size={17} />
                Добавить
              </button>
            </div>
            {s.categories.map((c: Category) => (
              <div className="management-row" key={c.id}>
                <div>
                  <b>{c.name}</b>
                  <small>
                    Порядок: {c.position}
                    {c.hidden ? " · Скрыта" : ""}
                  </small>
                </div>
                <button className="text-link" onClick={() => setCat({ ...c })}>
                  Изменить
                </button>
              </div>
            ))}
            {catDraft && (
              <form
                className="inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await run(
                    "/categories" + (catDraft.id ? "/" + catDraft.id : ""),
                    catDraft,
                    catDraft.id ? "PATCH" : "POST",
                    "Категория сохранена",
                    false,
                  );
                  if (r) setCat(null);
                }}
              >
                <label className="field">
                  Название категории
                  <input
                    required
                    maxLength={100}
                    value={catDraft.name}
                    onChange={(e) =>
                      setCat({ ...catDraft, name: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  Порядок
                  <input
                    required
                    type="number"
                    min={0}
                    max={10000}
                    value={catDraft.position}
                    onChange={(e) =>
                      setCat({ ...catDraft, position: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={catDraft.hidden}
                    onChange={(e) =>
                      setCat({ ...catDraft, hidden: e.target.checked })
                    }
                  />
                  Скрыть после обработки документов
                </label>
                <p className="muted">
                  Незавершённые карточки сначала перенесите через
                  редактирование. Скрытые категории сохраняют данные и историю.
                </p>
                <div className="small-actions">
                  <button className="button" disabled={busy}>
                    Сохранить категорию
                  </button>
                  <button type="button" onClick={() => setCat(null)}>
                    Отмена
                  </button>
                </div>
              </form>
            )}
          </section>
          <section className="panel">
            <h2>Передача администрирования</h2>
            <p className="muted">
              Выбранный участник получит право управления. Ваша рабочая роль
              сохранится, право администратора будет передано.
            </p>
            <label className="field">
              Новый администратор
              <select
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setTransferAck(false);
                }}
              >
                <option value="">Выберите участника</option>
                {s.users
                  .filter((u: User) => u.active && u.id !== s.me.id)
                  .map((u: User) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={transferAck}
                onChange={(e) => setTransferAck(e.target.checked)}
              />
              Подтверждаю передачу права управления
            </label>
            <button
              className="button"
              disabled={busy || !target || !transferAck}
              onClick={() =>
                run(
                  "/admin/transfer",
                  { userId: target },
                  "POST",
                  "Администрирование передано",
                  false,
                )
              }
            >
              Передать администрирование
            </button>
          </section>
        </>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
