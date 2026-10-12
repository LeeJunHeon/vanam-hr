"use client";

import { Plus, Trash2 } from "lucide-react";
import {
  PERF_FORM,
  TABLE_MAX_ROWS,
  TEXT_MAX,
  TEXTAREA_MAX,
  emptyRow,
  type PerfCellValue,
  type PerfContent,
  type PerfField,
  type PerfRow,
  type PerfTableSection,
} from "@/lib/performance/form";
import { SHEET_STATUS_META, type SheetStatus } from "@/lib/performance/rules";

// 분기 실적표 렌더러 — lib/performance/form.ts 의 PERF_FORM 정의를 읽어 그린다.
// readOnly 하나로 편집(내 실적) / 열람(제출 미리보기·관리자 열람) 겸용.

const INPUT_CLS =
  "w-full px-2.5 py-2 border border-gray-200 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-200";

export function PerfStatusBadge({ status }: { status: SheetStatus }) {
  const meta = SHEET_STATUS_META[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${meta.badgeClass}`}>
      {meta.label}
    </span>
  );
}

function displayValue(field: PerfField, row: PerfRow): string {
  if (field.kind === "computed") return field.compute(row);
  const v = row[field.key];
  return v == null ? "" : String(v);
}

function FieldLabel({ field }: { field: PerfField }) {
  return (
    <>
      {field.label}
      {field.required && <span className="text-rose-500 ml-0.5">*</span>}
    </>
  );
}

/** 칸 하나 — 편집 입력 또는 열람 텍스트 */
function Cell({
  field,
  row,
  readOnly,
  onChange,
  compact,
}: {
  field: PerfField;
  row: PerfRow;
  readOnly: boolean;
  onChange: (key: string, value: PerfCellValue) => void;
  /** 표 안(행 높이 낮게) */
  compact?: boolean;
}) {
  if (field.kind === "computed") {
    return <div className="px-1 py-2 text-sm font-semibold text-gray-700 tabular-nums">{field.compute(row)}</div>;
  }
  if (readOnly) {
    const text = displayValue(field, row);
    return (
      <div className={`px-1 py-1 text-sm whitespace-pre-wrap break-words ${text ? "text-gray-800" : "text-gray-300"}`}>
        {text || "-"}
      </div>
    );
  }
  const value = row[field.key] == null ? "" : String(row[field.key]);
  switch (field.kind) {
    case "select":
      return (
        <select value={value} onChange={(e) => onChange(field.key, e.target.value)} className={INPUT_CLS}>
          <option value="">선택</option>
          {field.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );
    case "number":
      return (
        <input
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
          placeholder={field.placeholder}
          className={`${INPUT_CLS} tabular-nums`}
        />
      );
    case "textarea":
      return (
        <textarea
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
          placeholder={field.placeholder}
          maxLength={TEXTAREA_MAX}
          rows={compact ? 2 : 4}
          className={`${INPUT_CLS} resize-y`}
        />
      );
    default:
      return (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
          placeholder={field.placeholder}
          maxLength={TEXT_MAX}
          className={INPUT_CLS}
        />
      );
  }
}

function TableSection({
  section,
  rows,
  readOnly,
  onRowsChange,
}: {
  section: PerfTableSection;
  rows: PerfRow[];
  readOnly: boolean;
  onRowsChange: (rows: PerfRow[]) => void;
}) {
  const update = (i: number, key: string, value: PerfCellValue) =>
    onRowsChange(rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  const remove = (i: number) => onRowsChange(rows.filter((_, idx) => idx !== i));
  const add = () => {
    if (rows.length >= TABLE_MAX_ROWS) return;
    onRowsChange([...rows, emptyRow(section)]);
  };
  // 최소 행 수 이하로는 지우지 않는다 (빈 행은 저장 시 사라진다)
  const canRemove = rows.length > section.minRows;

  if (readOnly && rows.length === 0) {
    return <p className="text-sm text-gray-400 px-1">입력한 내용이 없습니다.</p>;
  }

  return (
    <div>
      {/* sm 이상: 표 */}
      <div className="hidden sm:block overflow-x-auto border border-gray-100 rounded-xl">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs font-semibold text-gray-500">
            <tr>
              <th className="w-8 px-2 py-2 text-center">#</th>
              {section.fields.map((f) => (
                <th key={f.key} className="px-2 py-2 text-left whitespace-nowrap">
                  <FieldLabel field={f} />
                </th>
              ))}
              {!readOnly && <th className="w-10" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-gray-50 align-top">
                <td className="px-2 py-2.5 text-center text-xs text-gray-400">{i + 1}</td>
                {section.fields.map((f) => (
                  <td key={f.key} className={`px-1.5 py-1.5 ${f.kind === "textarea" ? "min-w-[220px]" : "min-w-[90px]"}`}>
                    <Cell field={f} row={row} readOnly={readOnly} onChange={(k, v) => update(i, k, v)} compact />
                  </td>
                ))}
                {!readOnly && (
                  <td className="px-1 py-1.5">
                    {canRemove && (
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                        aria-label={`${i + 1}행 삭제`}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 모바일: 행 하나 = 카드 하나 (같은 상태 공유) */}
      <div className="sm:hidden space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400">{i + 1}행</span>
              {!readOnly && canRemove && (
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                  aria-label={`${i + 1}행 삭제`}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            {section.fields.map((f) => (
              <div key={f.key}>
                <label className="block text-[11px] font-semibold text-gray-500 mb-1">
                  <FieldLabel field={f} />
                </label>
                <Cell field={f} row={row} readOnly={readOnly} onChange={(k, v) => update(i, k, v)} compact />
              </div>
            ))}
          </div>
        ))}
      </div>

      {!readOnly && (
        <button
          type="button"
          onClick={add}
          disabled={rows.length >= TABLE_MAX_ROWS}
          className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
          title={rows.length >= TABLE_MAX_ROWS ? `최대 ${TABLE_MAX_ROWS}행까지 입력할 수 있습니다` : undefined}
        >
          <Plus size={12} />행 추가
        </button>
      )}
    </div>
  );
}

export default function PerfSheetForm({
  content,
  onChange,
  readOnly,
}: {
  content: PerfContent;
  onChange?: (next: PerfContent) => void;
  readOnly: boolean;
}) {
  const ro = readOnly || !onChange;
  const setSection = (key: string, value: PerfRow[] | PerfRow) => onChange?.({ ...content, [key]: value });

  return (
    <div className="space-y-4">
      {PERF_FORM.map((section) => (
        <section key={section.key} className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
          <h3 className="text-sm font-bold text-gray-900">{section.title}</h3>
          {section.help && !ro && <p className="text-xs text-gray-400 mt-0.5">{section.help}</p>}
          <div className="mt-3">
            {section.kind === "table" ? (
              <TableSection
                section={section}
                rows={Array.isArray(content[section.key]) ? (content[section.key] as PerfRow[]) : []}
                readOnly={ro}
                onRowsChange={(rows) => setSection(section.key, rows)}
              />
            ) : (
              <div className="space-y-3">
                {section.fields.map((f) => {
                  const row = (content[section.key] as PerfRow | undefined) ?? {};
                  return (
                    <div key={f.key}>
                      <label className="block text-xs font-semibold text-gray-500 mb-1">
                        <FieldLabel field={f} />
                      </label>
                      <Cell
                        field={f}
                        row={row}
                        readOnly={ro}
                        onChange={(k, v) => setSection(section.key, { ...row, [k]: v })}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
