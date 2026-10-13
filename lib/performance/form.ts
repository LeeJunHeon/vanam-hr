// 분기 성과표 양식 정의 — 서버(API 검증)와 화면(PerfSheetForm 렌더러)이 같이 쓴다.
// ⚠ prisma 등 서버 전용 모듈을 import 하지 말 것 (클라이언트 번들에 들어감).
//
// 양식 = 부분(part) 배열, 부분 = 섹션 배열, 섹션 = 칸 배열. 특정 칸의 동작은 화면 컴포넌트에
// 하드코딩하지 않고 여기 정의의 속성으로 표현한다. 정리·검증·계산 함수는 양식을 마지막 인자로 받고
// 기본값은 PERF_FORM 이다.

import { isValidYmd } from "@/lib/performance/rules";

/**
 * 지금 양식이 예시인지 — true 면 성과 화면에 "예시 양식" 배지와 안내 띠가 보인다.
 * 실제 양식으로 바꿀 때 false 로 바꾼다.
 */
export const PERF_FORM_IS_EXAMPLE = false;

/** 새 성과표를 만들 때 perf_sheets.form_version 에 저장되는 값 */
export const PERF_FORM_VERSION = "v1";

export const TEXT_MAX = 200;
export const TEXTAREA_MAX = 2000;
export const URL_MAX = 500;
export const TABLE_MAX_ROWS = 30;
export const TABLE_MIN_WIDTH = 760;

export type PerfCellValue = string | number | null;
export type PerfRow = Record<string, PerfCellValue>;
/** { goals: [{...}], basic: {...} } — 표 섹션은 행 배열, fields 섹션은 객체 */
export type PerfContent = Record<string, PerfRow[] | PerfRow>;

/** info 칸에 자동으로 보여 줄 값 — 서버가 만들어 렌더러에 info prop 으로 넘긴다 */
export type PerfInfoSource = "employeeName" | "department" | "position" | "period" | "quarter";
export type PerfInfo = Partial<Record<PerfInfoSource, string>>;

interface FieldBase {
  key: string;
  label: string;
  /** 칸 이름 아래 작은 설명 */
  hint?: string;
  required?: boolean;
  placeholder?: string;
  /** 표 섹션의 열 너비 비율(%) — 한 표의 칸끼리 합이 100 이 되게 */
  width?: number;
  /** fields 섹션에서 칸 이름을 숨김 */
  hideLabel?: boolean;
}
/** 글자 칸 — maxLength 가 없으면 text 200 / textarea 2000 / url 500 (fieldMaxLength 로 얻는다) */
interface TextFieldBase extends FieldBase {
  maxLength?: number;
}
export type PerfField =
  | (TextFieldBase & { kind: "text" })
  | (TextFieldBase & { kind: "textarea" })
  | (TextFieldBase & { kind: "url" })
  | (FieldBase & { kind: "number"; min?: number; max?: number; suffix?: string })
  /** "YYYY-MM-DD" 로 저장 */
  | (FieldBase & { kind: "date" })
  | (FieldBase & {
      kind: "select";
      options: string[];
      /** 새 행·잘못된 값의 기본값 — 있으면 빈 "선택" 항목을 두지 않는다 */
      defaultValue?: string;
      /** 필수 검사·빈 행 판단에서 비어 있는 것으로 볼 값 */
      unsetValues?: string[];
    })
  /** 저장하지 않는 자동 표시 칸 (값은 렌더러의 info prop) */
  | (FieldBase & { kind: "info"; source: PerfInfoSource })
  /** 저장하지 않고 같은 행의 다른 칸으로 화면에서 계산 */
  | (FieldBase & { kind: "computed"; compute: (row: PerfRow) => string });

interface SectionBase {
  /** 저장 키 */
  key: string;
  title?: string;
  /** 오류 문구용 짧은 이름 */
  shortTitle?: string;
  /** 제목 아래 안내 (편집 화면에서만) */
  help?: string;
  /** 작성 원칙 목록 (편집 화면에서만) */
  guide?: { title: string; items: string[] };
  fields: PerfField[];
}

/** 숫자 열 합계 막대 */
export interface PerfTableSum {
  field: string;
  target: number;
  label: string;
  help?: string;
  /** 내용 있는 행이 없을 때 */
  emptyText: string;
  /** 내용 있는 행 중 그 칸이 빈 행이 있을 때 */
  missingText: string;
}

export interface PerfTableSection extends SectionBase {
  kind: "table";
  /** 맨 앞 번호 열 이름 (없으면 "#") */
  indexLabel?: string;
  /** 제출에 필요한 최소 행 (내용 있는 행 기준) */
  minRows: number;
  /** 빈 화면에 보여 줄 행 수 */
  initialRows?: number;
  /** 최대 행 수 (기본 30) */
  maxRows?: number;
  /** 행 수 고정 — 추가·삭제·순서 변경 없음, 저장할 때도 빈 행이 자리를 지켜 번호가 유지된다 */
  fixedRows?: number;
  /** ▲▼ 로 순서 변경 (순서가 곧 번호) */
  reorderable?: boolean;
  /** 넓은 화면 표 최소 너비 px (편집·읽기 전용 모두, 기본 760) */
  minWidth?: number;
  /** 열 묶음 머리글 — fields 는 칸 key, 묶음 안 칸은 이웃해 있어야 한다 */
  groups?: { label: string; fields: string[] }[];
  sum?: PerfTableSum;
}
export interface PerfFieldsSection extends SectionBase {
  kind: "fields";
  /** 넓은 화면 격자 열 수 (모바일은 1열) */
  columns?: 1 | 2 | 3;
}
export type PerfSection = PerfTableSection | PerfFieldsSection;

export interface PerfPart {
  key: string;
  /** "01" 같은 번호 */
  no: string;
  title: string;
  /** 작성 안내 (편집 화면에서만) */
  intro?: string;
  /** 부분 끝 "※" 안내 */
  notice?: string;
  sections: PerfSection[];
}
export type PerfForm = PerfPart[];

/** 숫자 칸 값 → 유한수 또는 null (입력 중인 문자열도 받는다) */
export function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 달성률 = 성과 / 목표 × 100 (소수 1자리 + "%"). 목표가 비었거나 0이면 "-" */
export function computeAchievementRate(target: unknown, actual: unknown): string {
  const t = toNumberOrNull(target);
  const a = toNumberOrNull(actual);
  if (t == null || t === 0 || a == null) return "-";
  return `${((a / t) * 100).toFixed(1)}%`;
}

// ── 실제 양식: VanaM 분기 성과목표 및 평가서 01~03 (04 면담 평가는 관리자용 별도 양식) ──
export const PERF_FORM: PerfForm = [
  {
    key: "goalsAndResults",
    no: "01",
    title: "목표와 결과",
    notice: "※ 분기 종료 후 목표를 소급 변경하지 않습니다. 증빙 자료와 실제 완료 단계로 성과를 확인합니다.",
    sections: [
      {
        kind: "fields",
        key: "basic",
        title: "기본 정보",
        columns: 3,
        fields: [
          { key: "employeeName", label: "직원명", kind: "info", source: "employeeName" },
          { key: "department", label: "부서", kind: "info", source: "department" },
          { key: "jobRole", label: "직무", kind: "text", maxLength: 100, placeholder: "예: ALD 공정 개발" },
          { key: "period", label: "평가기간", kind: "info", source: "period" },
          { key: "quarter", label: "평가분기", kind: "info", source: "quarter" },
          { key: "supervisor", label: "상급자", kind: "text", maxLength: 50, placeholder: "예: 홍길동 팀장" },
          { key: "position", label: "직급", kind: "info", source: "position" },
          { key: "agreedDate", label: "목표합의일", kind: "date" },
        ],
      },
      {
        kind: "table",
        key: "goals",
        title: "STEP 1 · 이번 분기 목표 (개수 제한 없음)",
        shortTitle: "이번 분기 목표",
        help: "목표는 필요한 만큼 행을 추가하세요. 각 목표의 중요도(%)를 직접 입력하고, 합계가 100%가 되도록 설정합니다.",
        indexLabel: "우선순위",
        reorderable: true,
        minRows: 1,
        initialRows: 3,
        maxRows: 30,
        minWidth: 1100,
        groups: [
          { label: "분기 초 · 목표 설정", fields: ["goal", "criteria", "weight", "deadline"] },
          { label: "분기 말 · 결과", fields: ["result", "status", "evidence"] },
        ],
        fields: [
          { key: "goal", label: "이번 분기 목표", hint: "본인 책임 포함", kind: "textarea", required: true, width: 17 },
          { key: "criteria", label: "성공 기준 / 목표치", hint: "정량적으로", kind: "textarea", required: true, width: 17 },
          { key: "weight", label: "중요도 (%)", hint: "개인 입력", kind: "number", required: true, min: 0, max: 100, suffix: "%", width: 8 },
          { key: "deadline", label: "완료기한", kind: "date", width: 13 },
          { key: "result", label: "실제 결과", hint: "분기 종료 시", kind: "textarea", required: true, width: 17 },
          {
            key: "status",
            label: "달성 상태",
            kind: "select",
            required: true,
            options: ["미평가", "진행 중", "달성", "부분 달성", "미달", "보류"],
            defaultValue: "미평가",
            unsetValues: ["미평가"],
            width: 11,
          },
          { key: "evidence", label: "증빙 링크 / 문서", kind: "url", placeholder: "https://… 또는 문서 이름", width: 17 },
        ],
        sum: {
          field: "weight",
          target: 100,
          label: "가중치 합계",
          help: "중요도 합계를 반드시 100%로 맞추세요.",
          emptyText: "목표를 입력하세요",
          missingText: "중요도 미입력",
        },
      },
      {
        kind: "fields",
        key: "goalChanges",
        title: "목표 변경 이력",
        help: "없으면 비워두세요.",
        columns: 1,
        fields: [{ key: "changes", label: "목표 변경 이력", kind: "textarea", hideLabel: true }],
      },
    ],
  },
  {
    key: "achievements",
    no: "02",
    title: "핵심 성과 기록",
    intro: "가장 중요한 성과 3~5건을 먼저 작성합니다. 연구개발·생산·영업·경영지원 모두 같은 양식을 사용합니다.",
    sections: [
      {
        kind: "table",
        key: "achievements",
        title: "이번 분기 회사에 기여한 주요 성과",
        shortTitle: "주요 성과",
        help: "활동 건수보다 실제 완료 결과가 중요합니다. 개인 기여·완료 단계·정량적 근거를 함께 기록하세요.",
        minRows: 1,
        initialRows: 3,
        maxRows: 30,
        minWidth: 1100,
        fields: [
          {
            key: "category",
            label: "성과 구분",
            kind: "select",
            options: ["소재·공정 연구", "논문·학술", "지식재산", "장비·SW", "고객·매출", "과제·지원금", "해외사업", "운영·구매", "기타"],
            width: 13,
          },
          { key: "achievement", label: "구체적 성과", hint: "결과 중심", kind: "textarea", required: true, width: 21 },
          {
            key: "stage",
            label: "실제 단계",
            kind: "select",
            options: ["준비", "제출·신청", "진행 중", "선정·채택", "계약·협약", "납품·게재", "수금·검증", "지연·중단"],
            width: 11,
          },
          { key: "basis", label: "정량적 근거", hint: "원·%·건·시간 등", kind: "textarea", width: 16 },
          { key: "role", label: "본인 역할", kind: "select", options: ["책임자", "공동수행", "기술지원", "행정지원"], width: 10 },
          { key: "impact", label: "회사에 준 효과", hint: "매출·연구·품질·비용", kind: "textarea", width: 16 },
          { key: "link", label: "증빙자료 URL", kind: "url", width: 13 },
        ],
        guide: {
          title: "짧은 작성 원칙",
          items: [
            "① 논문: 준비 / 투고 / 수정 / 채택 / 게재, 과제: 신청 / 선정 / 협약 / 수행을 구분합니다.",
            "② 매출: 견적 / 계약 / 납품 / 수금, 생산: 횟수 / 성공률 / 재작업을 구분합니다.",
            "③ 공동 성과에는 자신이 직접 담당한 부분을 적고, 관련 문서·실험 로그를 연결합니다.",
          ],
        },
      },
    ],
  },
  {
    key: "selfReview",
    no: "03",
    title: "자기평가와 다음 분기 계획",
    intro: "분기 종료 시 작성합니다. 성과·목표 미달 원인·다음 행동·필요한 지원을 구체적으로 작성하세요.",
    notice: "※ 연구 실패 자체보다 원인을 규명하고 다음 실험·행동으로 연결했는지를 중요하게 검토합니다.",
    sections: [
      {
        kind: "fields",
        key: "reflection",
        title: "이번 분기 스스로 돌아보기",
        columns: 1,
        fields: [
          { key: "best", label: "1. 가장 의미 있었던 성과 한 가지와 그 이유", kind: "textarea", required: true },
          { key: "shortfall", label: "2. 부족했던 점 또는 달성하지 못한 목표", kind: "textarea", required: true },
          { key: "cause", label: "3. 미달 원인: 내가 개선할 부분과 외부·회사 제약을 구분", kind: "textarea", required: true },
          { key: "nextAction", label: "4. 다음 분기에 구체적으로 다르게 실행할 행동", kind: "textarea", required: true },
          { key: "support", label: "5. 성과를 높이기 위해 회사에 요청할 지원", kind: "textarea" },
        ],
      },
      {
        kind: "table",
        key: "nextGoals",
        title: "다음 분기 목표 제안 · 면담 후 최종 확정",
        shortTitle: "다음 분기 목표 제안",
        help: "업무 목록이 아니라 측정할 수 있는 결과 1~3개를 적으세요. 다음 분기 성과표에서 불러와 최종 확정합니다.",
        indexLabel: "순위",
        fixedRows: 3,
        minRows: 1,
        fields: [
          { key: "goal", label: "다음 분기 목표", kind: "textarea", required: true, width: 45 },
          { key: "criteria", label: "완료 판단 기준", kind: "textarea", required: true, width: 40 },
          { key: "targetDate", label: "목표 시점", kind: "date", width: 15 },
        ],
      },
    ],
  },
];

// ── 04 면담 및 평가 기록 — 상급자·CEO(관리자)가 쓰고 관리자만 본다 (perf_sheets.review_content) ──
// 평가 확정일은 칸으로 두지 않고 확정 시각(review_finalized_at)을 보여 준다.
export const PERF_REVIEW_FORM: PerfForm = [
  {
    key: "review",
    no: "04",
    title: "면담 및 평가 기록",
    intro: "상급자·CEO 작성 · 증빙을 확인하고 합의 목표와 회사의 지원사항을 기록합니다. 비공개 인사 평정은 별도 관리하세요.",
    notice: "※ 사전에 합의되지 않은 목표로 소급 평가하지 않습니다. 등급은 성과 검증과 직원 의견 확인 후 확정합니다.",
    sections: [
      {
        kind: "fields",
        key: "meeting",
        columns: 3,
        fields: [
          { key: "meetingDate", label: "면담일", kind: "date", required: true },
          { key: "evaluator", label: "평가자", kind: "text", required: true, maxLength: 50 },
          {
            key: "grade",
            label: "종합평가 (선택)",
            kind: "select",
            options: ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D"],
          },
        ],
      },
      {
        kind: "fields",
        key: "notes",
        help: "작성 순서: 성과 확인 → 기대 수준과의 차이 → 직원 의견 → 다음 분기 목표 → 회사 지원사항 합의",
        columns: 1,
        fields: [
          { key: "strengths", label: "1. 확인된 주요 성과와 강점", kind: "textarea", required: true },
          { key: "improvements", label: "2. 개선이 필요한 부분과 역할별 기대 수준", kind: "textarea" },
          { key: "employeeView", label: "3. 직원 의견 및 평가와 다른 견해", kind: "textarea" },
          { key: "agreedGoals", label: "4. 합의한 다음 분기 핵심 목표와 점검 기준", kind: "textarea", required: true },
          { key: "support", label: "5. 회사가 지원하기로 한 사항 (담당자 / 기한 포함)", kind: "textarea" },
        ],
      },
      {
        kind: "fields",
        key: "followUp",
        columns: 3,
        fields: [{ key: "midCheckDate", label: "중간점검 예정일", kind: "date" }],
      },
    ],
  },
];

// ── 공용 함수 ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 양식의 모든 섹션 (부분 순서대로) + 소속 부분 */
export function formSections(form: PerfForm = PERF_FORM): { part: PerfPart; section: PerfSection }[] {
  return form.flatMap((part) => part.sections.map((section) => ({ part, section })));
}

/** 오류 문구용 섹션 이름 — shortTitle → title → 부분 title */
function sectionName(part: PerfPart, section: PerfSection): string {
  return section.shortTitle ?? section.title ?? part.title;
}

/** 저장 대상 칸만 (info·computed 제외) */
function storedFields(fields: PerfField[]): PerfField[] {
  return fields.filter((f) => f.kind !== "computed" && f.kind !== "info");
}

export function tableMaxRows(section: PerfTableSection): number {
  return section.fixedRows ?? section.maxRows ?? TABLE_MAX_ROWS;
}

/** 글자 칸의 최대 글자 수 — 화면 maxLength 와 서버 sanitize 가 같이 쓴다. 글자 칸이 아니면 null */
export function fieldMaxLength(field: PerfField): number | null {
  if (field.kind === "text") return field.maxLength ?? TEXT_MAX;
  if (field.kind === "textarea") return field.maxLength ?? TEXTAREA_MAX;
  if (field.kind === "url") return field.maxLength ?? URL_MAX;
  return null;
}

function sanitizeValue(field: PerfField, raw: unknown): PerfCellValue {
  switch (field.kind) {
    case "text":
    case "textarea":
    case "url":
      return typeof raw === "string" ? raw.trim().slice(0, fieldMaxLength(field) ?? undefined) : "";
    case "number":
      return toNumberOrNull(raw);
    case "date":
      return isValidYmd(raw) ? raw : "";
    case "select":
      return typeof raw === "string" && field.options.includes(raw) ? raw : field.defaultValue ?? "";
    default:
      return null;
  }
}

/**
 * 칸 값이 "비었는지" — 빈 행·내용 유무·필수 검사가 모두 이 함수를 쓴다.
 * null, 빈 문자열, select 의 defaultValue 와 같은 값, unsetValues 에 든 값은 빈 값이다.
 */
export function isEmptyFieldValue(field: PerfField, v: PerfCellValue | undefined): boolean {
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (field.kind === "select" && typeof v === "string") {
    if (field.defaultValue != null && v === field.defaultValue) return true;
    if (field.unsetValues?.includes(v)) return true;
  }
  return false;
}

function sanitizeRow(fields: PerfField[], raw: unknown): PerfRow {
  const src = isPlainObject(raw) ? raw : {};
  const row: PerfRow = {};
  for (const f of storedFields(fields)) row[f.key] = sanitizeValue(f, src[f.key]);
  return row;
}

/** 행의 저장 칸이 전부 비었는지 */
export function isRowEmpty(fields: PerfField[], row: PerfRow): boolean {
  return storedFields(fields).every((f) => isEmptyFieldValue(f, row[f.key]));
}

/** 빈 행 하나 (표 행 추가용) — select 는 defaultValue 로 시작 */
export function emptyRow(section: PerfTableSection): PerfRow {
  return sanitizeRow(section.fields, {});
}

/**
 * 정의에 맞게 정리한다: 정의에 없는 키 제거, 글자는 trim·최대 글자 수, 숫자는 유한수 아니면 null,
 * 날짜는 실제 날짜가 아니면 "", select 는 options 밖이면 defaultValue 또는 "". info·computed 는 저장하지 않는다.
 * 표는 빈 행을 지우고 maxRows 까지 — fixedRows 표만 빈 행을 지우지 않고 정확히 그 행 수로 맞춘다.
 * 항상 모든 섹션 키를 가진다.
 */
export function sanitizeContent(raw: unknown, form: PerfForm = PERF_FORM): PerfContent {
  const src = isPlainObject(raw) ? raw : {};
  const out: PerfContent = {};
  for (const { section: s } of formSections(form)) {
    if (s.kind === "table") {
      const rawRows = Array.isArray(src[s.key]) ? (src[s.key] as unknown[]) : [];
      const rows = rawRows.map((r) => sanitizeRow(s.fields, r));
      if (s.fixedRows != null) {
        const fixed = rows.slice(0, s.fixedRows);
        while (fixed.length < s.fixedRows) fixed.push(emptyRow(s));
        out[s.key] = fixed;
      } else {
        out[s.key] = rows.filter((r) => !isRowEmpty(s.fields, r)).slice(0, tableMaxRows(s));
      }
    } else {
      out[s.key] = sanitizeRow(s.fields, src[s.key]);
    }
  }
  return out;
}

/**
 * 화면 표시용 — 표 섹션을 initialRows(없으면 minRows)·fixedRows 까지 빈 행으로 채운다.
 * 저장 시 빈 행은 sanitize 가 지운다 (fixedRows 표는 자리를 지킨다).
 */
export function withDisplayRows(content: PerfContent, form: PerfForm = PERF_FORM): PerfContent {
  const out: PerfContent = { ...content };
  for (const { section: s } of formSections(form)) {
    if (s.kind !== "table") continue;
    const rows = Array.isArray(out[s.key]) ? [...(out[s.key] as PerfRow[])] : [];
    const want = s.fixedRows ?? s.initialRows ?? s.minRows;
    while (rows.length < want) rows.push(emptyRow(s));
    out[s.key] = s.fixedRows != null ? rows.slice(0, s.fixedRows) : rows;
  }
  return out;
}

/** 무엇이든 입력한 내용이 있는지 */
export function hasAnyContent(content: unknown, form: PerfForm = PERF_FORM): boolean {
  const c = sanitizeContent(content, form);
  return formSections(form).some(({ section: s }) =>
    s.kind === "table"
      ? (c[s.key] as PerfRow[]).some((r) => !isRowEmpty(s.fields, r))
      : !isRowEmpty(s.fields, c[s.key] as PerfRow)
  );
}

/** 숫자 표시 — 부동소수 오차를 지우고 소수 둘째 자리까지 */
export function formatPerfNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export type PerfSumState = "empty" | "missing" | "ok" | "mismatch";

/**
 * 합계 상태 — 화면 막대와 제출 검증이 같이 쓴다.
 * 내용 있는 행 없음 → emptyText / 그 칸이 빈 행 있음 → missingText /
 * 합계 = target → "정상 - {target}%" / 그 외 → "합계가 {target}%가 아닙니다". 부동소수 오차는 허용.
 */
export function tableSumStatus(
  section: PerfTableSection,
  rows: PerfRow[]
): { state: PerfSumState; total: number; text: string; ok: boolean } | null {
  const sum = section.sum;
  if (!sum) return null;
  const field = section.fields.find((f) => f.key === sum.field);
  if (!field) return null;
  const suffix = field.kind === "number" ? field.suffix ?? "" : "";
  const filled = rows.filter((r) => !isRowEmpty(section.fields, r));
  let total = 0;
  let missing = false;
  for (const r of filled) {
    const n = toNumberOrNull(r[sum.field]);
    if (n == null) missing = true;
    else total += n;
  }
  total = Math.round(total * 1e6) / 1e6;
  if (filled.length === 0) return { state: "empty", total, text: sum.emptyText, ok: false };
  if (missing) return { state: "missing", total, text: sum.missingText, ok: false };
  if (Math.abs(total - sum.target) < 1e-6) {
    return { state: "ok", total, text: `정상 - ${sum.target}${suffix}`, ok: true };
  }
  return { state: "mismatch", total, text: `합계가 ${sum.target}${suffix}가 아닙니다`, ok: false };
}

function requiredMessage(field: PerfField): string {
  return field.kind === "select"
    ? `${field.label} 항목을 선택해 주세요.`
    : `${field.label} 항목을 입력해 주세요.`;
}

function rangeMessage(field: PerfField, v: PerfCellValue | undefined): string | null {
  if (field.kind !== "number" || typeof v !== "number") return null;
  if ((field.min != null && v < field.min) || (field.max != null && v > field.max)) {
    return `${field.label} 값은 ${field.min ?? ""}~${field.max ?? ""} 사이로 입력해 주세요.`;
  }
  return null;
}

/**
 * 제출 전 검증 — 오류 메시지 배열 (비어 있으면 제출 가능).
 * 표의 행 번호는 받은 배열의 위치 기준(빈 행 제거 전)이라 화면 번호와 같다.
 */
export function validateForSubmit(content: unknown, form: PerfForm = PERF_FORM): string[] {
  const src = isPlainObject(content) ? content : {};
  const errors: string[] = [];
  for (const { part, section: s } of formSections(form)) {
    const name = sectionName(part, s);
    const stored = storedFields(s.fields);
    if (s.kind === "table") {
      const rawRows = Array.isArray(src[s.key]) ? (src[s.key] as unknown[]) : [];
      // sanitize 와 같은 범위만 본다 (fixedRows 는 그 행 수, 아니면 내용 있는 행 maxRows 개)
      const indexed = rawRows
        .slice(0, s.fixedRows ?? rawRows.length)
        .map((r, i) => ({ row: sanitizeRow(s.fields, r), no: i + 1 }))
        .filter(({ row }) => !isRowEmpty(s.fields, row))
        .slice(0, tableMaxRows(s));
      if (indexed.length < s.minRows) {
        errors.push(`${name}: 최소 ${s.minRows}행을 입력해 주세요.`);
      }
      for (const { row, no } of indexed) {
        for (const f of stored) {
          if (f.required && isEmptyFieldValue(f, row[f.key])) {
            errors.push(`${name} ${no}행: ${requiredMessage(f)}`);
            continue;
          }
          const range = rangeMessage(f, row[f.key]);
          if (range) errors.push(`${name} ${no}행: ${range}`);
        }
      }
      // 빈 칸은 위 필수 검사가 알려 주므로 합계는 모든 행에 값이 있을 때만
      const st = tableSumStatus(s, indexed.map((x) => x.row));
      if (st && st.state === "mismatch" && s.sum) {
        const field = s.fields.find((f) => f.key === s.sum!.field);
        const suffix = field?.kind === "number" ? field.suffix ?? "" : "";
        errors.push(
          `${name}: ${s.sum.label} ${formatPerfNumber(st.total)}${suffix} — ${s.sum.target}${suffix}로 맞춰 주세요.`
        );
      }
    } else {
      const row = sanitizeRow(s.fields, src[s.key]);
      for (const f of stored) {
        if (f.required && isEmptyFieldValue(f, row[f.key])) {
          errors.push(`${name}: ${requiredMessage(f)}`);
          continue;
        }
        const range = rangeMessage(f, row[f.key]);
        if (range) errors.push(`${name}: ${range}`);
      }
    }
  }
  return errors;
}

// ── 지난 분기 제안 불러오기 ──
// ⚠ 아래는 PERF_FORM 의 칸 key(nextGoals → goals, basic.jobRole·supervisor)에 맞춰져 있다.
//    양식이 바뀌면 이 부분도 같이 바꾼다.

export interface PerfProposal {
  goal: string;
  criteria: string;
  targetDate: string;
}

/** 직전 분기 성과표에서 가져온 값 (GET my/sheet 의 previous) */
export interface PerfPrevious {
  label: string;
  jobRole: string;
  supervisor: string;
  proposals: PerfProposal[];
}

function str(v: PerfCellValue | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 지난 분기 성과표 내용 → 목표가 있는 다음 분기 제안 + 직무·상급자 */
export function extractPrevious(
  raw: unknown,
  label: string
): PerfPrevious | null {
  const c = sanitizeContent(raw);
  const proposals = ((c.nextGoals as PerfRow[]) ?? [])
    .map((r) => ({ goal: str(r.goal), criteria: str(r.criteria), targetDate: str(r.targetDate) }))
    .filter((p) => p.goal !== "");
  if (proposals.length === 0) return null;
  const basic = (c.basic as PerfRow) ?? {};
  return { label, jobRole: str(basic.jobRole), supervisor: str(basic.supervisor), proposals };
}

/** 아직 이번 분기 목표에 없는 제안 (목표 문구 앞뒤 공백 무시 비교) */
export function pendingProposals(content: PerfContent, previous: PerfPrevious | null): PerfProposal[] {
  if (!previous) return [];
  const rows = Array.isArray(content.goals) ? (content.goals as PerfRow[]) : [];
  const seen = new Set(rows.map((r) => str(r.goal)).filter(Boolean));
  const out: PerfProposal[] = [];
  for (const p of previous.proposals) {
    if (seen.has(p.goal)) continue;
    seen.add(p.goal);
    out.push(p);
  }
  return out;
}

/**
 * 지난 분기 제안을 이번 분기 goals 표로 옮긴다 (goal→goal, criteria→criteria, targetDate→deadline, 나머지 기본값).
 * 같은 목표 문구가 이미 있으면 건너뛰고, 빈 행부터 채운 뒤 모자라면 뒤에 추가 — maxRows 를 넘기지 않는다.
 * 직무·상급자가 비어 있으면 지난 값으로 채운다.
 */
export function importPreviousProposals(
  content: PerfContent,
  previous: PerfPrevious | null,
  form: PerfForm = PERF_FORM
): { content: PerfContent; imported: number } {
  const section = formSections(form)
    .map((x) => x.section)
    .find((s): s is PerfTableSection => s.kind === "table" && s.key === "goals");
  if (!previous || !section) return { content, imported: 0 };

  const rows = Array.isArray(content.goals) ? [...(content.goals as PerfRow[])] : [];
  const max = tableMaxRows(section);
  let imported = 0;
  for (const p of pendingProposals(content, previous)) {
    const row: PerfRow = { ...emptyRow(section), goal: p.goal, criteria: p.criteria, deadline: p.targetDate };
    const emptyIdx = rows.findIndex((r) => isRowEmpty(section.fields, r));
    if (emptyIdx >= 0) rows[emptyIdx] = row;
    else if (rows.length < max) rows.push(row);
    else break;
    imported++;
  }

  const basic: PerfRow = { ...((content.basic as PerfRow | undefined) ?? {}) };
  if (!str(basic.jobRole) && previous.jobRole) basic.jobRole = previous.jobRole;
  if (!str(basic.supervisor) && previous.supervisor) basic.supervisor = previous.supervisor;

  return { content: { ...content, goals: rows, basic }, imported };
}
