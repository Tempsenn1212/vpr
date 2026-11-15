import React, { useState } from "react";
import {
  readinessTerms,
  type Doc,
  type RecurringRule,
  type State,
} from "./types";
import { AppSelect } from "./AppSelect";
import { CheckCheck } from "lucide-react";

const weekdays = [
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
  "Воскресенье",
];
const dayLabel = (rule: RecurringRule, day: number) =>
  rule.cadence === "weekly"
    ? day === 0
      ? "Конец месяца"
      : (day > 7 ? "Следующая неделя: " : "") + weekdays[(day - 1) % 7]
    : day === 31
      ? "Последний день месяца"
      : `${day}-е число`;
export function ruleDescription(rule: RecurringRule) {
  const period = {
    weekly: "Каждую неделю",
    monthly: "Каждый месяц",
    quarterly: "Каждый квартал, последний месяц",
    callup: "В июле и декабре",
  }[rule.cadence];
  return `${period}. ${readinessTerms({ categoryId: rule.category_id }).imperative}: ${dayLabel(rule, rule.ready_day)}. ${rule.category_id === "category-12" ? "Сдать" : "Вложить"}: ${dayLabel(rule, rule.placement_day)}.`;
}
function RuleEditor({ rule, busy, run }: any) {
  const [enabled, setEnabled] = useState(!!rule.enabled),
    [ready, setReady] = useState(rule.ready_day),
    [placement, setPlacement] = useState(rule.placement_day);
  const options = (place = false) => {
    const weekly = rule.cadence === "weekly";
    const values = Array.from(
      { length: weekly ? (place ? 15 : 7) : 31 },
      (_, i) => (weekly && place ? i : i + 1),
    );
    return values.map((day) => ({
      id: String(day),
      name: dayLabel(rule, day),
    }));
  };
  return (
    <form
      className="recurring-rule"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          `/recurring-rules/${rule.id}`,
          {
            version: rule.version,
            enabled,
            ready_day: ready,
            placement_day: placement,
          },
          "PATCH",
          "Расписание документов сохранено",
          false,
        );
      }}
    >
      <h3>{rule.title}</h3>
      <p className="muted">
        {ruleDescription(rule)}
        {rule.item_count
          ? ` В одной карточке: ${rule.item_count} листов беседы.`
          : ""}
      </p>
      <div className="form-row">
        <label className="field">
          {readinessTerms({ categoryId: rule.category_id }).imperative}
          <AppSelect
            label={`${readinessTerms({ categoryId: rule.category_id }).noun}: ${rule.title}`}
            value={String(ready)}
            onChange={(value) => setReady(Number(value))}
            options={options()}
          />
        </label>
        <label className="field">
          {rule.category_id === "category-12" ? "Сдать" : "Вложить в журнал"}
          <AppSelect
            label={`${rule.category_id === "category-12" ? "Сдача" : "Вложение"}: ${rule.title}`}
            value={String(placement)}
            onChange={(value) => setPlacement(Number(value))}
            options={options(true)}
          />
        </label>
      </div>
      <div className="small-actions">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Создавать автоматически
        </label>
        <button className="button secondary" disabled={busy}>
          Сохранить расписание документа
        </button>
      </div>
    </form>
  );
}
export function RecurringPanel({
  s,
  busy,
  run,
}: {
  s: State;
  busy: boolean;
  run: any;
}) {
  return (
    <section className="panel">
      <h2>Автоматическое создание карточек</h2>
      <p className="muted">
        Карточки появляются в начале недели, месяца или квартала. При
        перезапуске сервер добавляет пропущенные периоды. Изменения расписания
        действуют для новых карточек; сроки уже созданных можно изменить в самих
        документах.
      </p>
      {s.recurringRules.map((rule) => (
        <details className="rule-details" key={rule.id}>
          <summary>
            {rule.title} · {rule.enabled ? "включено" : "выключено"}
          </summary>
          <RuleEditor key={rule.version} rule={rule} busy={busy} run={run} />
        </details>
      ))}
    </section>
  );
}
function ItemRow({ item, doc, busy, run }: any) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false),
    [label, setLabel] = useState(item.label);
  const locked = doc.completed || doc.deleted;
  return (
    <div className="subdocument-row">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={pending ?? !!item.ready}
          disabled={busy || locked || editing || pending !== null}
          onChange={async (e) => {
            const done = e.target.checked;
            setPending(done);
            try {
              await run(
                `/documents/${doc.id}/items/${item.id}`,
                { version: doc.version, done },
                "PATCH",
                "Лист беседы обновлён",
                false,
              );
            } finally {
              setPending(null);
            }
          }}
        />
        <span>
          {item.label}
          {item.ready && <small>Оформлен · {item.ready.name}</small>}
        </span>
      </label>
      {!locked && !editing && (
        <button
          className="text-link"
          onClick={() => {
            setLabel(item.label);
            setEditing(true);
          }}
        >
          Изменить
        </button>
      )}
      {editing && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await run(
              `/documents/${doc.id}/items/${item.id}`,
              { version: doc.version, label },
              "PATCH",
              "Название листа сохранено",
              false,
            );
            if (result) setEditing(false);
          }}
        >
          <label className="field">
            Имя военнослужащего или название
            <input
              aria-label={`Название листа: ${item.label}`}
              maxLength={150}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <button className="button secondary" disabled={busy}>
            Сохранить название
          </button>
          <button
            type="button"
            className="text-link"
            onClick={() => setEditing(false)}
          >
            Отмена
          </button>
        </form>
      )}
    </div>
  );
}
export function Subdocuments({
  doc,
  busy,
  run,
}: {
  doc: Doc;
  busy: boolean;
  run: any;
}) {
  if (!doc.items?.length) return null;
  const done = doc.items.filter((i) => i.ready).length;
  return (
    <section className="subdocuments">
      <h3>Листы беседы за месяц</h3>
      <p>
        Оформлено: {done} из {doc.items.length}. После оформления всех листов
        отметьте вложение группы в журнал.
      </p>
      <progress
        value={done}
        max={doc.items.length}
        aria-label="Оформление листов беседы"
      />
      {!doc.completed && !doc.deleted && (
        <button
          type="button"
          className="button subdocuments-mark-all"
          disabled={
            busy || (done === doc.items.length && doc.status === "READY")
          }
          onClick={() =>
            void run(
              `/documents/${doc.id}/items/complete`,
              { version: doc.version },
              "POST",
              "Все 40 листов беседы отмечены",
              false,
            )
          }
        >
          <CheckCheck size={18} />
          Отметить все 40 листов
        </button>
      )}
      {doc.items.map((item) => (
        <ItemRow key={item.id} item={item} doc={doc} busy={busy} run={run} />
      ))}
    </section>
  );
}
