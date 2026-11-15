import { Folder } from "lucide-react";
import { AppSelect } from "./AppSelect";
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
  return (
    <AppSelect
      options={[
        ...(allLabel ? [{ id: allValue, name: allLabel }] : []),
        ...categories,
      ]}
      value={value}
      onChange={onChange}
      label={label}
      required={required}
      searchLabel="Поиск в списке категорий"
      searchPlaceholder="Найти категорию"
      placeholder="Выберите категорию"
      emptyText="Категории не найдены"
      icon={<Folder size={17} />}
    />
  );
}
