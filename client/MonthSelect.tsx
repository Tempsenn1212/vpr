import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { AppSelect } from "./AppSelect";
import { monthOptions, shiftMonth } from "./months";
import type { Doc } from "./types";

export function MonthSelect({
  documents,
  today,
  value,
  onChange,
  reset,
}: {
  documents: Doc[];
  today: string;
  value: string;
  onChange: (month: string) => void;
  reset: () => void;
}) {
  const current = today.slice(0, 7);
  return (
    <section className="month-toolbar" aria-label="Выбор месяца документов">
      <div className="month-field">
        <span className="eyebrow">МЕСЯЦ ДОКУМЕНТОВ</span>
        <div className="month-controls">
          <button
            className="month-arrow"
            aria-label="Предыдущий месяц"
            disabled={!value || value <= "1900-01"}
            onClick={() => onChange(shiftMonth(value, -1))}
          >
            <ChevronLeft size={18} />
          </button>
          <AppSelect
            label="Месяц документов"
            options={monthOptions(documents, current, value)}
            value={value}
            onChange={onChange}
            icon={<CalendarDays size={17} />}
          />
          <button
            className="month-arrow"
            aria-label="Следующий месяц"
            disabled={!value || value >= "2200-12"}
            onClick={() => onChange(shiftMonth(value, 1))}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <div className="month-explanation">
        <p>Отбор по сроку вложения в журнал или сдачи.</p>
        <button
          className="button secondary"
          onClick={reset}
          disabled={value === current}
        >
          Текущий месяц
        </button>
      </div>
    </section>
  );
}
