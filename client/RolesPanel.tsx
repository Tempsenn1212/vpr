import React, { useState } from "react";
import { Plus, ShieldCheck } from "lucide-react";
import type { Role, State } from "./types";
import { permissionCatalog } from "../shared/permissions.ts";
export function RolesPanel({
  s,
  busy,
  run,
}: {
  s: State;
  busy: boolean;
  run: any;
}) {
  const [draft, setDraft] = useState<
    (Omit<Role, "id"> & { id?: string }) | null
  >(null);
  const latest = draft?.id ? s.roles.find((r) => r.id === draft.id) : null;
  const stale = latest && latest.version !== draft?.version;
  const groups = [...new Set(permissionCatalog.map((p) => p.group))];
  return (
    <section className="panel roles-panel" aria-label="Роли и права">
      <div className="section-title">
        <h2>Роли и права</h2>
        <button
          className="button secondary"
          onClick={() => setDraft({ name: "", permissions: [], version: 1 })}
        >
          <Plus size={17} />
          Добавить роль
        </button>
      </div>
      <p className="muted">
        Все активные участники могут просматривать общий журнал. Остальные
        действия определяются правами роли. Изменения применяются ко всем
        участникам этой роли.
      </p>
      <p className="muted">
        Право администратора сохраняет управление доступом, категориями,
        расписаниями и копиями независимо от роли. Подтверждение документов
        определяется отдельно.
      </p>
      {s.roles.map((role) => (
        <div className="management-row" key={role.id}>
          <div>
            <b>{role.name}</b>
            <small>
              {role.permissions.length
                ? `Прав: ${role.permissions.length}`
                : "Только просмотр журнала"}{" "}
              · Участников: {s.users.filter((u) => u.role === role.id).length}
            </small>
          </div>
          <button
            className="text-link"
            aria-label={"Изменить роль " + role.name}
            onClick={() =>
              setDraft({ ...role, permissions: [...role.permissions] })
            }
          >
            Изменить
          </button>
        </div>
      ))}
      {draft && (
        <form
          className="inline-form role-editor"
          aria-label="Настройка роли"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await run(
              "/roles" + (draft.id ? "/" + draft.id : ""),
              draft,
              draft.id ? "PATCH" : "POST",
              "Роль сохранена",
              false,
            );
            if (result) setDraft(null);
          }}
        >
          <h3>{draft.id ? "Редактировать роль" : "Новая роль"}</h3>
          {stale && (
            <div className="warning">
              Роль изменена другим участником. Ваш черновик сохранён.{" "}
              <button
                type="button"
                className="text-link"
                onClick={() =>
                  setDraft({
                    ...latest!,
                    permissions: [...latest!.permissions],
                  })
                }
              >
                Загрузить актуальную роль
              </button>
            </div>
          )}
          <label className="field">
            Название роли
            <input
              aria-label="Название роли"
              required
              maxLength={80}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoFocus
            />
          </label>
          <div className="permission-groups">
            {groups.map((group) => (
              <fieldset key={group}>
                <legend>
                  <ShieldCheck size={16} />
                  {group}
                </legend>
                {permissionCatalog
                  .filter((p) => p.group === group)
                  .map((p) => (
                    <label className="checkbox" key={p.id}>
                      <input
                        type="checkbox"
                        checked={draft.permissions.includes(p.id)}
                        onChange={(e) => {
                          let permissions = e.target.checked
                            ? [...draft.permissions, p.id]
                            : draft.permissions.filter((x) => x !== p.id);
                          if (
                            p.id === "reviews.create" &&
                            e.target.checked &&
                            !permissions.includes("reviews.view")
                          )
                            permissions.push("reviews.view");
                          if (p.id === "reviews.view" && !e.target.checked)
                            permissions = permissions.filter(
                              (x) => x !== "reviews.create",
                            );
                          setDraft({ ...draft, permissions });
                        }}
                      />
                      <span>{p.label}</span>
                    </label>
                  ))}
              </fieldset>
            ))}
          </div>
          <div className="small-actions">
            <button className="button" disabled={busy}>
              Сохранить роль
            </button>
            <button
              type="button"
              className="text-link"
              onClick={() => setDraft(null)}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
