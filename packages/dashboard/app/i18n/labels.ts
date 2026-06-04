import { COLUMN_LABELS, type Column } from "@fusion/core";
import { useTranslation } from "react-i18next";

/**
 * Returns a translator for board column labels, backed by the `common:columns.*`
 * keys with the English `COLUMN_LABELS` as the fallback. This is the migration
 * pattern for the centralized core label constants: import the hook, call it,
 * and replace `COLUMN_LABELS[col]` with `columnLabel(col)`.
 */
export function useColumnLabel(): (column: Column) => string {
  const { t } = useTranslation("common");
  return (column: Column) => t(`columns.${column}`, COLUMN_LABELS[column]);
}
