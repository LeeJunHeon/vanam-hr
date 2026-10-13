"use client";

import { Fragment, createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Paperclip, Plus, Trash2, X } from "lucide-react";
import AutoTextarea from "@/components/performance/AutoTextarea";
import { withBasePath } from "@/lib/base-path";
import { formatFileSize } from "@/lib/file-size";
import {
  PERF_FILE_ACCEPT,
  perfFileUrl,
  type PerfFileMeta,
  type PerfUploadResult,
} from "@/lib/performance/files";
import {
  PERF_FORM,
  PERF_FORM_IS_EXAMPLE,
  TABLE_MIN_WIDTH,
  addEvidenceFile,
  emptyRow,
  evidenceMaxFiles,
  isEvidenceValue,
  fieldMaxLength,
  formatPerfNumber,
  isRowEmpty,
  tableMaxRows,
  tableSumStatus,
  type PerfCellValue,
  type PerfContent,
  type PerfEvidenceValue,
  type PerfField,
  type PerfFieldsSection,
  type PerfForm,
  type PerfInfo,
  type PerfRow,
  type PerfSection,
  type PerfTableSection,
} from "@/lib/performance/form";
import { SHEET_STATUS_META, formatYmdDot, type SheetStatus } from "@/lib/performance/rules";

// 분기 성과표 렌더러 — lib/performance/form.ts 의 양식 정의(부분 → 섹션 → 칸)를 읽어 그린다.
// readOnly 하나로 편집(내 성과) / 열람(제출 미리보기·관리자 열람) 겸용.

const INPUT_CLS =
  "w-full px-2.5 py-2 border border-gray-200 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-200";

// 한 줄 칸 높이 = 줄 높이 20 + 위아래 padding 16 + border 2. 브라우저마다 select 기본 높이가 달라(크롬 40px)
// select·숫자·날짜 칸을 여기에 고정해 빈 AutoTextarea(한 줄, 38px)와 정확히 맞춘다.
const SINGLE_LINE_H = "h-[38px]";

const GRID_COLS: Record<1 | 2 | 3, string> = {
  1: "",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
};

const ICON_BTN =
  "p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400";

/** 화면 제목 옆 "예시 양식" 배지 — PERF_FORM_IS_EXAMPLE 가 false 면 그리지 않는다 */
export function PerfExampleBadge() {
  if (!PERF_FORM_IS_EXAMPLE) return null;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700">
      예시 양식
    </span>
  );
}

export function PerfStatusBadge({ status }: { status: SheetStatus }) {
  const meta = SHEET_STATUS_META[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${meta.badgeClass}`}>
      {meta.label}
    </span>
  );
}

function FieldLabel({ field }: { field: PerfField }) {
  return (
    <>
      {field.label}
      {field.required && <span className="text-rose-500 ml-0.5">*</span>}
    </>
  );
}

function FieldHint({ field }: { field: PerfField }) {
  if (!field.hint) return null;
  return <span className="block text-[10px] font-normal text-gray-400 mt-0.5">{field.hint}</span>;
}

function isHttpUrl(v: string): boolean {
  return /^https?:\/\//i.test(v);
}

/** info 칸 — 편집·읽기 모두 회색 읽기 전용 상자 (한 줄 입력칸과 같은 높이) */
function InfoBox({ value }: { value: string | undefined }) {
  return (
    <div
      className={`min-h-[38px] px-2.5 py-2 border border-gray-100 rounded-lg bg-gray-50 text-sm [overflow-wrap:anywhere] ${
        value ? "text-gray-700" : "text-gray-300"
      }`}
    >
      {value || "-"}
    </div>
  );
}

/** 읽기 전용 칸 값 */
function ReadOnlyValue({ field, row }: { field: PerfField; row: PerfRow }) {
  const v = row[field.key];
  const empty = <div className="px-1 py-1 text-sm text-gray-300">-</div>;
  if (v == null || (typeof v === "string" && v.trim() === "")) return empty;
  const base = "px-1 py-1 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]";
  const text = String(v);
  switch (field.kind) {
    case "date":
      return <div className={`${base} text-gray-800 tabular-nums`}>{formatYmdDot(text)}</div>;
    case "number":
      return (
        <div className={`${base} text-gray-800 tabular-nums`}>
          {typeof v === "number" ? formatPerfNumber(v) : text}
          {field.suffix ?? ""}
        </div>
      );
    case "url":
      return (
        <div className={`${base} text-gray-800`}>
          {isHttpUrl(text) ? (
            <a href={text} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              {text}
            </a>
          ) : (
            text
          )}
        </div>
      );
    case "select":
      return (
        <div className={`${base} ${field.unsetValues?.includes(text) ? "text-gray-400" : "text-gray-800"}`}>
          {text}
        </div>
      );
    default:
      return <div className={`${base} text-gray-800`}>{text}</div>;
  }
}

// ── 증빙 칸 (링크·문서 이름 + 첨부 파일) ──

interface EvidenceContextValue {
  /** 파일 id → 메타. 메타가 없는 id(지워진 파일 등)는 칩을 그리지 않는다 */
  files: Record<number, PerfFileMeta>;
  /** 없으면 [파일 첨부] 버튼을 그리지 않는다 */
  upload?: (file: File) => Promise<PerfUploadResult>;
  /** 업로드가 끝난 그 순간의 최신 내용에 파일 id 를 더한다 (올리는 동안 입력한 다른 칸을 덮어쓰지 않게) */
  addFile: (sectionKey: string, rowIndex: number | null, field: PerfField, fileId: number) => void;
}
const EvidenceContext = createContext<EvidenceContextValue>({ files: {}, addFile: () => {} });

const EMPTY_EVIDENCE: PerfEvidenceValue = { text: "", fileIds: [] };
const ERROR_CLEAR_MS = 5000;

function toEvidence(v: PerfCellValue | undefined): PerfEvidenceValue {
  if (isEvidenceValue(v)) return v;
  return typeof v === "string" ? { text: v, fileIds: [] } : EMPTY_EVIDENCE;
}

/** 파일 칩 — 누르면 새 탭으로 열기(pdf·이미지는 바로 보기, 그 밖은 내려받기) */
function FileChip({ meta, onRemove }: { meta: PerfFileMeta; onRemove?: () => void }) {
  return (
    <span
      className={`inline-flex items-center gap-1 max-w-full min-w-0 bg-gray-100 border border-gray-200 rounded-full pl-2.5 py-0.5 text-[11px] text-gray-700 ${
        onRemove ? "pr-1" : "pr-2.5"
      }`}
    >
      {/* <a href> 는 BasePathFetch 가 고쳐 주지 않으므로 withBasePath 로 만든다 */}
      <a
        href={withBasePath(perfFileUrl(meta.id))}
        target="_blank"
        rel="noopener noreferrer"
        title={meta.fileName}
        className="truncate min-w-0 hover:text-blue-600 hover:underline"
      >
        {meta.fileName}
      </a>
      <span className="text-gray-400 shrink-0">{formatFileSize(meta.fileSize)}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="p-0.5 rounded-full text-gray-400 hover:text-rose-600 hover:bg-rose-50 shrink-0"
          aria-label={`${meta.fileName} 삭제`}
        >
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/** 읽기 전용 증빙 — 링크(http/https 면 새 탭) 또는 글자 + 파일 칩. 둘 다 없으면 "-" */
function EvidenceView({ value }: { value: PerfCellValue | undefined }) {
  const { files } = useContext(EvidenceContext);
  const v = toEvidence(value);
  const metas = v.fileIds.map((id) => files[id]).filter((m): m is PerfFileMeta => !!m);
  if (!v.text && metas.length === 0) return <div className="px-1 py-1 text-sm text-gray-300">-</div>;
  return (
    <div className="px-1 py-1 space-y-1">
      {v.text && (
        <div className="text-sm text-gray-800 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {isHttpUrl(v.text) ? (
            <a href={v.text} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
              {v.text}
            </a>
          ) : (
            v.text
          )}
        </div>
      )}
      {metas.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {metas.map((m) => (
            <FileChip key={m.id} meta={m} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 편집 증빙 — 한 줄 입력 + [파일 첨부] + 파일 칩(삭제는 칸 값에서 id 를 빼는 것뿐, 파일 정리는 서버가 한다) */
function EvidenceInput({
  field,
  value,
  onValueChange,
  sectionKey,
  rowIndex,
}: {
  field: PerfField;
  value: PerfCellValue | undefined;
  onValueChange: (next: PerfEvidenceValue) => void;
  sectionKey: string;
  rowIndex: number | null;
}) {
  const { files, upload, addFile } = useContext(EvidenceContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  useEffect(
    () => () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    },
    []
  );

  const v = toEvidence(value);
  const max = evidenceMaxFiles(field);
  const full = v.fileIds.length >= max;
  const metas = v.fileIds.map((id) => files[id]).filter((m): m is PerfFileMeta => !!m);
  const fullText = `파일은 칸마다 최대 ${max}개까지 올릴 수 있습니다`;

  const clearError = () => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = null;
    setError("");
  };
  const showError = (msg: string) => {
    clearError();
    setError(msg);
    errorTimer.current = setTimeout(() => setError(""), ERROR_CLEAR_MS);
  };

  /** 고른 파일을 칸의 남은 자리만큼 하나씩 차례로 올린다 */
  const handlePick = async (list: FileList | null) => {
    const picked = list ? Array.from(list) : [];
    if (inputRef.current) inputRef.current.value = "";
    if (!upload || picked.length === 0) return;
    clearError();
    const room = Math.max(0, max - v.fileIds.length);
    let lastError = picked.length > room ? fullText : "";
    setUploading(true);
    for (const f of picked.slice(0, room)) {
      const r = await upload(f);
      if (r.ok) addFile(sectionKey, rowIndex, field, r.file.id);
      else lastError = r.error;
    }
    setUploading(false);
    if (lastError) showError(lastError);
  };

  return (
    <div className="space-y-1.5">
      <AutoTextarea
        value={v.text}
        onChange={(text) => onValueChange({ ...v, text })}
        placeholder={field.placeholder}
        maxLength={fieldMaxLength(field) ?? 0}
        singleLine
        className={INPUT_CLS}
      />
      {(upload || metas.length > 0) && (
        <div className="flex flex-wrap items-center gap-1">
          {metas.map((m) => (
            <FileChip
              key={m.id}
              meta={m}
              onRemove={() => onValueChange({ ...v, fileIds: v.fileIds.filter((id) => id !== m.id) })}
            />
          ))}
          {upload && (
            <>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={uploading || full}
                title={full ? fullText : undefined}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
              >
                <Paperclip size={12} />
                {uploading ? "올리는 중…" : "파일 첨부"}
              </button>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={PERF_FILE_ACCEPT}
                className="hidden"
                onChange={(e) => handlePick(e.target.files)}
              />
            </>
          )}
        </div>
      )}
      {error && <p className="text-[11px] text-rose-600">{error}</p>}
    </div>
  );
}

/** 칸 하나 — 편집 입력 또는 열람 텍스트 */
function Cell({
  field,
  row,
  readOnly,
  onChange,
  info,
  compact,
  sectionKey,
  rowIndex,
}: {
  field: PerfField;
  row: PerfRow;
  readOnly: boolean;
  onChange: (key: string, value: PerfCellValue) => void;
  info?: PerfInfo;
  /** 표 안(행 높이 낮게) */
  compact?: boolean;
  /** 칸 위치 — 증빙 업로드가 끝난 뒤 최신 내용에 파일 id 를 더할 때 쓴다 (fields 섹션은 rowIndex null) */
  sectionKey: string;
  rowIndex: number | null;
}) {
  if (field.kind === "info") return <InfoBox value={info?.[field.source]} />;
  if (field.kind === "evidence") {
    return readOnly ? (
      <EvidenceView value={row[field.key]} />
    ) : (
      <EvidenceInput
        field={field}
        value={row[field.key]}
        onValueChange={(next) => onChange(field.key, next)}
        sectionKey={sectionKey}
        rowIndex={rowIndex}
      />
    );
  }
  if (field.kind === "computed") {
    return <div className="px-1 py-2 text-sm font-semibold text-gray-700 tabular-nums">{field.compute(row)}</div>;
  }
  if (readOnly) return <ReadOnlyValue field={field} row={row} />;

  const value = row[field.key] == null ? "" : String(row[field.key]);
  const ariaLabel = field.hideLabel ? field.label : undefined;
  switch (field.kind) {
    case "select":
      return (
        <select
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
          aria-label={ariaLabel}
          className={`${INPUT_CLS} ${SINGLE_LINE_H} py-0`}
        >
          {field.defaultValue == null && <option value="">선택</option>}
          {field.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );
    case "number":
      return (
        <div className="relative">
          <input
            type="number"
            inputMode="decimal"
            value={value}
            min={field.min}
            max={field.max}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.placeholder}
            aria-label={ariaLabel}
            className={`${INPUT_CLS} ${SINGLE_LINE_H} tabular-nums ${field.suffix ? "pr-7" : ""}`}
          />
          {field.suffix && (
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">
              {field.suffix}
            </span>
          )}
        </div>
      );
    case "date":
      return (
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
          aria-label={ariaLabel}
          className={`${INPUT_CLS} ${SINGLE_LINE_H} py-0 tabular-nums`}
        />
      );
    case "textarea":
      // 표 안은 빈 칸일 때 한 줄, fields 섹션은 3줄에서 시작 — 내용에 따라 늘어남
      return (
        <AutoTextarea
          value={value}
          onChange={(v) => onChange(field.key, v)}
          placeholder={field.placeholder}
          maxLength={fieldMaxLength(field) ?? 0}
          minRows={compact ? 1 : 3}
          className={INPUT_CLS}
        />
      );
    default:
      // text·url — 한 줄 항목. 긴 내용은 옆으로 숨지 않고 아래로 늘어남, 줄바꿈은 공백으로
      return (
        <AutoTextarea
          value={value}
          onChange={(v) => onChange(field.key, v)}
          placeholder={field.placeholder}
          maxLength={fieldMaxLength(field) ?? 0}
          singleLine
          className={INPUT_CLS}
        />
      );
  }
}

/** 칸 key → 묶음 (groups 정의) */
function groupOf(section: PerfTableSection, key: string) {
  return section.groups?.find((g) => g.fields.includes(key)) ?? null;
}

function SumBar({ section, rows, readOnly }: { section: PerfTableSection; rows: PerfRow[]; readOnly: boolean }) {
  const st = tableSumStatus(section, rows);
  if (!st || !section.sum) return null;
  const field = section.fields.find((f) => f.key === section.sum!.field);
  const suffix = field?.kind === "number" ? field.suffix ?? "" : "";
  return (
    <div
      className={`mt-2 rounded-xl border px-3 py-2 text-sm ${
        st.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-700"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="font-semibold tabular-nums">
          {section.sum.label} {formatPerfNumber(st.total)}
          {suffix}
        </span>
        <span>{st.text}</span>
      </div>
      {!readOnly && section.sum.help && <p className="text-xs mt-0.5 opacity-80">{section.sum.help}</p>}
    </div>
  );
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
  const fixed = section.fixedRows != null;
  const maxRows = tableMaxRows(section);
  const update = (i: number, key: string, value: PerfCellValue) =>
    onRowsChange(rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  const remove = (i: number) => onRowsChange(rows.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    onRowsChange(next);
  };
  const add = () => {
    if (rows.length >= maxRows) return;
    onRowsChange([...rows, emptyRow(section)]);
  };
  const canRemove = !fixed && rows.length > 1;
  const canReorder = !fixed && !!section.reorderable;
  const showOps = !readOnly && !fixed;

  // 읽기 전용: 빈 행은 숨긴다. fixedRows 표는 원래 번호를 유지, 나머지는 보이는 순서대로 번호
  const visible = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => !readOnly || !isRowEmpty(section.fields, row))
    .map((x, vi) => ({ ...x, no: readOnly && !fixed ? vi + 1 : x.i + 1 }));

  if (readOnly && visible.length === 0) {
    return (
      <div>
        <p className="text-sm text-gray-400 px-1">입력한 내용이 없습니다.</p>
        <SumBar section={section} rows={rows} readOnly={readOnly} />
      </div>
    );
  }

  const indexLabel = section.indexLabel ?? "#";
  const hasGroups = !!section.groups?.length;
  const headRowSpan = hasGroups ? 2 : 1;

  const ops = (i: number) => (
    <div className="flex items-center justify-end gap-0.5">
      {canReorder && (
        <>
          <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className={ICON_BTN} aria-label={`${i + 1}행 위로`}>
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            onClick={() => move(i, 1)}
            disabled={i === rows.length - 1}
            className={ICON_BTN}
            aria-label={`${i + 1}행 아래로`}
          >
            <ChevronDown size={14} />
          </button>
        </>
      )}
      {canRemove && (
        <button
          type="button"
          onClick={() => remove(i)}
          className="p-1 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50"
          aria-label={`${i + 1}행 삭제`}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );

  return (
    <div>
      {/* sm 이상: 표 — 최소 너비보다 좁으면 가로 스크롤 */}
      <div className="hidden sm:block overflow-x-auto border border-gray-100 rounded-xl">
        {/* table-fixed + colgroup — 열 너비는 양식의 width 비율을 따르고 내용 길이로 흔들리지 않음 */}
        <table className="w-full table-fixed text-sm" style={{ minWidth: section.minWidth ?? TABLE_MIN_WIDTH }}>
          <colgroup>
            <col className={section.indexLabel ? "w-16" : "w-10"} />
            {section.fields.map((f) => (
              <col key={f.key} style={f.width ? { width: `${f.width}%` } : undefined} />
            ))}
            {showOps && <col className={canReorder ? "w-[5.5rem]" : "w-11"} />}
          </colgroup>
          <thead className="bg-gray-50 text-xs font-semibold text-gray-500">
            {hasGroups && (
              <tr>
                <th rowSpan={headRowSpan} className="px-2 py-2 text-center align-middle break-keep">
                  {indexLabel}
                </th>
                {section.fields.map((f) => {
                  const g = groupOf(section, f.key);
                  if (!g) {
                    return (
                      <th key={f.key} rowSpan={headRowSpan} className="px-2 py-2 text-left align-bottom break-keep">
                        <FieldLabel field={f} />
                        <FieldHint field={f} />
                      </th>
                    );
                  }
                  // 묶음의 첫 칸에서만 묶음 머리글을 그린다 (이웃한 칸 수만큼 가로로 묶음)
                  if (g.fields.find((k) => section.fields.some((x) => x.key === k)) !== f.key) return null;
                  const span = section.fields.filter((x) => g.fields.includes(x.key)).length;
                  return (
                    <th
                      key={`g-${g.label}`}
                      colSpan={span}
                      className="px-2 py-1.5 text-center text-[11px] text-gray-600 border-b border-gray-200 border-l border-l-gray-100 first:border-l-0"
                    >
                      {g.label}
                    </th>
                  );
                })}
                {showOps && <th rowSpan={headRowSpan} />}
              </tr>
            )}
            <tr>
              {!hasGroups && <th className="px-2 py-2 text-center break-keep">{indexLabel}</th>}
              {section.fields
                .filter((f) => !hasGroups || groupOf(section, f.key))
                .map((f) => (
                  <th key={f.key} className="px-2 py-2 text-left align-bottom break-keep">
                    <FieldLabel field={f} />
                    <FieldHint field={f} />
                  </th>
                ))}
              {!hasGroups && showOps && <th />}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ row, i, no }) => (
              <tr key={i} className="border-t border-gray-50 align-top">
                <td className="px-2 py-2.5 text-center text-xs text-gray-400 tabular-nums">{no}</td>
                {section.fields.map((f) => (
                  <td key={f.key} className="px-1.5 py-1.5">
                    <Cell
                      field={f}
                      row={row}
                      readOnly={readOnly}
                      onChange={(k, v) => update(i, k, v)}
                      compact
                      sectionKey={section.key}
                      rowIndex={i}
                    />
                  </td>
                ))}
                {showOps && <td className="px-1 py-1.5">{ops(i)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 모바일: 행 하나 = 카드 하나 (같은 상태 공유) */}
      <div className="sm:hidden space-y-2">
        {visible.map(({ row, i, no }) => (
          <div key={i} className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400">
                {section.indexLabel ? `${section.indexLabel} ${no}` : `${no}행`}
              </span>
              {showOps && ops(i)}
            </div>
            {section.fields.map((f, fi) => {
              const g = groupOf(section, f.key);
              const prevG = fi > 0 ? groupOf(section, section.fields[fi - 1].key) : null;
              return (
                <Fragment key={f.key}>
                  {g && g !== prevG && (
                    <p className="pt-1 text-[11px] font-bold text-gray-600 border-b border-gray-200 pb-1">{g.label}</p>
                  )}
                  <div>
                    <label className="block text-[11px] font-semibold text-gray-500 mb-1">
                      <FieldLabel field={f} />
                      <FieldHint field={f} />
                    </label>
                    <Cell
                      field={f}
                      row={row}
                      readOnly={readOnly}
                      onChange={(k, v) => update(i, k, v)}
                      compact
                      sectionKey={section.key}
                      rowIndex={i}
                    />
                  </div>
                </Fragment>
              );
            })}
          </div>
        ))}
      </div>

      {!readOnly && !fixed && (
        <button
          type="button"
          onClick={add}
          disabled={rows.length >= maxRows}
          className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
          title={rows.length >= maxRows ? `최대 ${maxRows}행까지 입력할 수 있습니다` : undefined}
        >
          <Plus size={12} />행 추가
        </button>
      )}

      <SumBar section={section} rows={rows} readOnly={readOnly} />
    </div>
  );
}

function FieldsSection({
  section,
  row,
  readOnly,
  info,
  onRowChange,
}: {
  section: PerfFieldsSection;
  row: PerfRow;
  readOnly: boolean;
  info?: PerfInfo;
  onRowChange: (row: PerfRow) => void;
}) {
  return (
    <div className={`grid grid-cols-1 gap-3 ${GRID_COLS[section.columns ?? 1]}`}>
      {section.fields.map((f) => (
        <div key={f.key} className="min-w-0">
          {!f.hideLabel && (
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              <FieldLabel field={f} />
              <FieldHint field={f} />
            </label>
          )}
          <Cell
            field={f}
            row={row}
            readOnly={readOnly}
            info={info}
            onChange={(k, v) => onRowChange({ ...row, [k]: v })}
            sectionKey={section.key}
            rowIndex={null}
          />
        </div>
      ))}
    </div>
  );
}

function SectionCard({
  section,
  content,
  readOnly,
  info,
  setSection,
}: {
  section: PerfSection;
  content: PerfContent;
  readOnly: boolean;
  info?: PerfInfo;
  setSection: (key: string, value: PerfRow[] | PerfRow) => void;
}) {
  return (
    <section className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
      {section.title && <h3 className="text-sm font-bold text-gray-900">{section.title}</h3>}
      {section.help && !readOnly && <p className="text-xs text-gray-400 mt-0.5">{section.help}</p>}
      {section.guide && !readOnly && (
        <div className="mt-2 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2">
          <p className="text-xs font-semibold text-gray-600">{section.guide.title}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-gray-500">
            {section.guide.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={section.title || section.help || section.guide ? "mt-3" : ""}>
        {section.kind === "table" ? (
          <TableSection
            section={section}
            rows={Array.isArray(content[section.key]) ? (content[section.key] as PerfRow[]) : []}
            readOnly={readOnly}
            onRowsChange={(rows) => setSection(section.key, rows)}
          />
        ) : (
          <FieldsSection
            section={section}
            row={(content[section.key] as PerfRow | undefined) ?? {}}
            readOnly={readOnly}
            info={info}
            onRowChange={(row) => setSection(section.key, row)}
          />
        )}
      </div>
    </section>
  );
}

export default function PerfSheetForm({
  form = PERF_FORM,
  content,
  onChange,
  readOnly,
  info,
  titleAside,
  files,
  onUpload,
  onUpdate,
}: {
  form?: PerfForm;
  content: PerfContent;
  onChange?: (next: PerfContent) => void;
  readOnly: boolean;
  /** 증빙 파일 id → 메타 */
  files?: Record<number, PerfFileMeta>;
  /** 증빙 파일 올리기 — 없으면 [파일 첨부] 버튼을 그리지 않는다 */
  onUpload?: (file: File) => Promise<PerfUploadResult>;
  /** "최신 내용 → 새 내용" 변경 — 업로드처럼 늦게 끝나는 변경이 그 사이 입력을 덮어쓰지 않게 */
  onUpdate?: (fn: (latest: PerfContent) => PerfContent) => void;
  /** info 칸 값 (직원명·부서·직급·평가기간·평가분기) */
  info?: PerfInfo;
  /** 부분 제목 옆에 붙일 표시 (예: 04 의 "관리자 전용") */
  titleAside?: ReactNode;
}) {
  const ro = readOnly || !onChange;
  const setSection = (key: string, value: PerfRow[] | PerfRow) => onChange?.({ ...content, [key]: value });
  const evidence: EvidenceContextValue = {
    files: files ?? {},
    upload: ro ? undefined : onUpload,
    addFile: (sectionKey, rowIndex, field, fileId) => {
      const fn = (latest: PerfContent) => addEvidenceFile(latest, sectionKey, rowIndex, field, fileId);
      if (onUpdate) onUpdate(fn);
      else onChange?.(fn(content));
    },
  };

  return (
    <EvidenceContext.Provider value={evidence}>
      <div className="space-y-6">
        {/* 편집·제출 미리보기·관리자 열람 모두 이 렌더러를 쓰므로 여기 한 곳에서 안내 */}
        {PERF_FORM_IS_EXAMPLE && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-800">
            예시 양식입니다. 실제 성과표 양식이 정해지면 바뀌며, 지금 입력한 내용은 새 양식으로 옮겨지지 않을 수 있습니다.
          </div>
        )}
        {form.map((part) => (
          <div key={part.key} className="space-y-3">
            <div>
              <h2 className="flex flex-wrap items-center gap-2 text-base font-bold text-gray-900">
                <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-md bg-gray-900 text-white text-[11px] font-bold tabular-nums">
                  {part.no}
                </span>
                {part.title}
                {titleAside}
              </h2>
              {part.intro && !ro && <p className="text-xs text-gray-500 mt-1">{part.intro}</p>}
            </div>
            {part.sections.map((section) => (
              <SectionCard
                key={section.key}
                section={section}
                content={content}
                readOnly={ro}
                info={info}
                setSection={setSection}
              />
            ))}
            {part.notice && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800">
                {part.notice}
              </div>
            )}
          </div>
        ))}
      </div>
    </EvidenceContext.Provider>
  );
}
