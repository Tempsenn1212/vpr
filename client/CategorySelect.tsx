import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, Folder } from "lucide-react";
import type { Category } from "./types";

export function CategorySelect({
  categories,
  value,
  onChange,
  label = "Категория",
  allLabel,
  allValue = "",
  required = false,
}: {
  categories: Category[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  allLabel?: string;
  allValue?: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 300,
    height: 300,
  });
  const trigger = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null);
  const id = useId();
  const options = [
    ...(allLabel ? [{ id: allValue, name: allLabel }] : []),
    ...categories,
  ];
  const filtered = options.filter((c) =>
    c.name
      .toLocaleLowerCase("ru")
      .includes(query.trim().toLocaleLowerCase("ru")),
  );
  const chosen = options.find((c) => c.id === value);
  const close = (focus = false) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  const choose = (next: string) => {
    onChange(next);
    close(true);
  };
  const measure = () => {
    const rect = trigger.current!.getBoundingClientRect();
    const viewport = window.visualViewport;
    const bottom =
      (viewport?.offsetTop || 0) + (viewport?.height || innerHeight);
    const viewportWidth = viewport?.width || innerWidth;
    const viewportLeft = viewport?.offsetLeft || 0;
    const below = bottom - rect.bottom - 12,
      above = rect.top - (viewport?.offsetTop || 0) - 12;
    const upward = below < 240 && above > below;
    const height = Math.max(
      80,
      Math.min(
        340,
        upward ? above : below,
        (viewport?.height || innerHeight) - 24,
      ),
    );
    const width = Math.min(Math.max(rect.width, 300), viewportWidth - 24);
    return {
      left: Math.max(
        viewportLeft + 12,
        Math.min(rect.left, viewportLeft + viewportWidth - width - 12),
      ),
      top: Math.max(
        (viewport?.offsetTop || 0) + 8,
        Math.min(
          upward ? rect.top - height - 6 : rect.bottom + 6,
          bottom - height - 8,
        ),
      ),
      width,
      height,
    };
  };
  const show = () => {
    setPosition(measure());
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((c) => c.id === value),
      ),
    );
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      const inside =
        event.target instanceof Node &&
        (popup.current?.contains(event.target) ||
          trigger.current?.contains(event.target));
      if (!inside) close();
    };
    const move = (event: Event) => {
      if (
        !(
          event.target instanceof Node && popup.current?.contains(event.target)
        ) &&
        trigger.current
      )
        setPosition(measure());
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", move);
    window.addEventListener("scroll", move, true);
    window.visualViewport?.addEventListener("resize", move);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", move);
      window.removeEventListener("scroll", move, true);
      window.visualViewport?.removeEventListener("resize", move);
    };
  }, [open]);
  useEffect(() => {
    popup.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, query, open]);
  const keyboard = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((n) =>
        Math.max(
          0,
          Math.min(
            filtered.length - 1,
            n + (event.key === "ArrowDown" ? 1 : -1),
          ),
        ),
      );
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : Math.max(0, filtered.length - 1));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (filtered[active]) choose(filtered[active].id);
    }
    if (event.key === "Tab") close(true);
  };
  return (
    <div className="category-select">
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-required={required}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? id : undefined}
        className={"category-select-trigger" + (open ? " expanded" : "")}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            if (!open) show();
          }
        }}
      >
        <Folder size={17} />
        <span>{chosen?.name || "Выберите категорию"}</span>
        <ChevronDown size={17} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="category-select-popup"
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.height,
            }}
          >
            <div className="category-select-search">
              <Search size={17} />
              <input
                ref={search}
                aria-label="Поиск в списке категорий"
                placeholder="Найти категорию"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={keyboard}
                aria-controls={id}
                aria-activedescendant={
                  filtered[active] ? `${id}-${active}` : undefined
                }
              />
            </div>
            <div
              id={id}
              role="listbox"
              aria-label={label}
              className="category-select-options"
              style={{ maxHeight: Math.max(60, position.height - 60) }}
            >
              {filtered.map((option, i) => (
                <button
                  type="button"
                  role="option"
                  id={`${id}-${i}`}
                  key={option.id}
                  aria-selected={option.id === value}
                  data-active={i === active}
                  className={option.id === value ? "selected" : ""}
                  onPointerMove={() => setActive(i)}
                  onClick={() => choose(option.id)}
                >
                  <span>{option.name}</span>
                  {option.id === value && <Check size={17} />}
                </button>
              ))}
              {!filtered.length && (
                <p className="category-select-empty">Категории не найдены</p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
