// 분기 실적표 양식 정의 — 서버(API 검증)와 화면(PerfSheetForm 렌더러)이 같이 쓴다.
// ⚠ prisma 등 서버 전용 모듈을 import 하지 말 것 (클라이언트 번들에 들어감).
//
// 지금 양식은 예시다. 실제 양식을 받으면 이 파일의 PERF_FORM 과 PERF_FORM_VERSION 만 바꾸면
// 화면·저장·제출 검증이 함께 바뀐다.

/** 새 실적표를 만들 때 perf_sheets.form_version 에 저장되는 값 */
export const PERF_FORM_VERSION = "example-v1";

export const TEXT_MAX = 200;
export const TEXTAREA_MAX = 2000;
export const TABLE_MAX_ROWS = 30;

export type PerfCellValue = string | number | null;
export type PerfRow = Record<string, PerfCellValue>;
/** { tasks: [{...}], kpis: [{...}], review: {...} } — 표 섹션은 행 배열, fields 섹션은 객체 */
export type PerfContent = Record<string, PerfRow[] | PerfRow>;

interface FieldBase {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
}
export type PerfField =
  | (FieldBase & { kind: "text" })
  | (FieldBase & { kind: "textarea" })
  | (FieldBase & { kind: "number" })
  | (FieldBase & { kind: "select"; options: string[] })
  /** 저장하지 않고 같은 행의 다른 칸으로 화면에서 계산 */
  | (FieldBase & { kind: "computed"; compute: (row: PerfRow) => string });

export interface PerfTableSection {
  kind: "table";
  key: string;
  title: string;
  help?: string;
  minRows: number;
  fields: PerfField[];
}
export interface PerfFieldsSection {
  kind: "fields";
  key: string;
  title: string;
  help?: string;
  fields: PerfField[];
}
export type PerfSection = PerfTableSection | PerfFieldsSection;

/** 숫자 칸 값 → 유한수 또는 null (입력 중인 문자열도 받는다) */
export function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 달성률 = 실적 / 목표 × 100 (소수 1자리 + "%"). 목표가 비었거나 0이면 "-" */
export function computeAchievementRate(target: unknown, actual: unknown): string {
  const t = toNumberOrNull(target);
  const a = toNumberOrNull(actual);
  if (t == null || t === 0 || a == null) return "-";
  return `${((a / t) * 100).toFixed(1)}%`;
}

// ── 예시 양식 ──
export const PERF_FORM: PerfSection[] = [
  {
    kind: "table",
    key: "tasks",
    title: "주요 업무 실적",
    help: "이번 분기에 수행한 주요 업무를 한 줄씩 적어 주세요.",
    minRows: 1,
    fields: [
      { key: "category", label: "업무 구분", kind: "select", options: ["연구개발", "생산·공정", "영업·고객", "관리·기타"] },
      { key: "title", label: "업무 내용", kind: "text", required: true },
      { key: "period", label: "기간", kind: "text", placeholder: "예: 10/1~11/15" },
      { key: "result", label: "결과·성과", kind: "textarea" },
      { key: "status", label: "진행 상태", kind: "select", options: ["완료", "진행 중", "보류"] },
    ],
  },
  {
    kind: "table",
    key: "kpis",
    title: "목표 대비 실적",
    help: "수치로 관리하는 목표가 있으면 적어 주세요.",
    minRows: 0,
    fields: [
      { key: "item", label: "목표 항목", kind: "text" },
      { key: "unit", label: "단위", kind: "text" },
      { key: "target", label: "목표", kind: "number" },
      { key: "actual", label: "실적", kind: "number" },
      {
        key: "rate",
        label: "달성률",
        kind: "computed",
        compute: (row) => computeAchievementRate(row.target, row.actual),
      },
    ],
  },
  {
    kind: "fields",
    key: "review",
    title: "자기 평가 및 다음 분기 계획",
    fields: [
      { key: "strengths", label: "잘한 점", kind: "textarea" },
      { key: "improvements", label: "아쉬운 점·개선할 점", kind: "textarea" },
      { key: "nextPlan", label: "다음 분기 계획", kind: "textarea", required: true },
    ],
  },
];

// ── 공용 함수 ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 저장 대상 칸만 (computed 제외) */
function storedFields(fields: PerfField[]): PerfField[] {
  return fields.filter((f) => f.kind !== "computed");
}

function sanitizeValue(field: PerfField, raw: unknown): PerfCellValue {
  switch (field.kind) {
    case "text":
      return typeof raw === "string" ? raw.trim().slice(0, TEXT_MAX) : "";
    case "textarea":
      return typeof raw === "string" ? raw.trim().slice(0, TEXTAREA_MAX) : "";
    case "number":
      return toNumberOrNull(raw);
    case "select":
      return typeof raw === "string" && field.options.includes(raw) ? raw : "";
    default:
      return null;
  }
}

function isEmptyValue(v: PerfCellValue | undefined): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

function sanitizeRow(fields: PerfField[], raw: unknown): PerfRow {
  const src = isPlainObject(raw) ? raw : {};
  const row: PerfRow = {};
  for (const f of storedFields(fields)) row[f.key] = sanitizeValue(f, src[f.key]);
  return row;
}

/** 행의 저장 칸이 전부 비었는지 */
export function isRowEmpty(fields: PerfField[], row: PerfRow): boolean {
  return storedFields(fields).every((f) => isEmptyValue(row[f.key]));
}

/**
 * 정의에 맞게 정리한다: 정의에 없는 키 제거, 문자열 trim·길이 제한, 숫자는 유한수 아니면 null,
 * select 는 options 밖이면 "", 표는 완전히 빈 행 제거 후 최대 30행. 항상 모든 섹션 키를 가진다.
 */
export function sanitizeContent(raw: unknown): PerfContent {
  const src = isPlainObject(raw) ? raw : {};
  const out: PerfContent = {};
  for (const s of PERF_FORM) {
    if (s.kind === "table") {
      const rows = Array.isArray(src[s.key]) ? (src[s.key] as unknown[]) : [];
      out[s.key] = rows
        .map((r) => sanitizeRow(s.fields, r))
        .filter((r) => !isRowEmpty(s.fields, r))
        .slice(0, TABLE_MAX_ROWS);
    } else {
      out[s.key] = sanitizeRow(s.fields, src[s.key]);
    }
  }
  return out;
}

/** 빈 행 하나 (표 행 추가용) */
export function emptyRow(section: PerfTableSection): PerfRow {
  return sanitizeRow(section.fields, {});
}

/** 화면 표시용 — 표 섹션을 최소 행 수(없으면 0)만큼 빈 행으로 채운다. 저장 시 빈 행은 sanitize 가 지운다. */
export function withMinRows(content: PerfContent): PerfContent {
  const out: PerfContent = { ...content };
  for (const s of PERF_FORM) {
    if (s.kind !== "table") continue;
    const rows = Array.isArray(out[s.key]) ? [...(out[s.key] as PerfRow[])] : [];
    while (rows.length < s.minRows) rows.push(emptyRow(s));
    out[s.key] = rows;
  }
  return out;
}

/** 무엇이든 입력한 내용이 있는지 */
export function hasAnyContent(content: unknown): boolean {
  const c = sanitizeContent(content);
  return PERF_FORM.some((s) =>
    s.kind === "table"
      ? (c[s.key] as PerfRow[]).length > 0
      : !isRowEmpty(s.fields, c[s.key] as PerfRow)
  );
}

/** 제출 전 검증 — 오류 메시지 배열 (비어 있으면 제출 가능) */
export function validateForSubmit(content: unknown): string[] {
  const c = sanitizeContent(content);
  const errors: string[] = [];
  for (const s of PERF_FORM) {
    const required = storedFields(s.fields).filter((f) => f.required);
    if (s.kind === "table") {
      const rows = c[s.key] as PerfRow[];
      if (rows.length < s.minRows) {
        errors.push(`${s.title}: 최소 ${s.minRows}행을 입력해 주세요.`);
      }
      rows.forEach((row, i) => {
        for (const f of required) {
          if (isEmptyValue(row[f.key])) {
            errors.push(`${s.title} ${i + 1}행: ${f.label} 항목을 입력해 주세요.`);
          }
        }
      });
    } else {
      const row = c[s.key] as PerfRow;
      for (const f of required) {
        if (isEmptyValue(row[f.key])) {
          errors.push(`${s.title}: ${f.label} 항목을 입력해 주세요.`);
        }
      }
    }
  }
  return errors;
}
