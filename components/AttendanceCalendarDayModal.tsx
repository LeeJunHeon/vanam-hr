"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  correctedRangeLabel,
  formatTime as libFormatTime,
  AUTO_STATUS_META,
  EVAL_STATUS,
  dayOffsetFromWorkDate,
  dayOffsetTitle,
} from "@/lib/attendanceLabels";
import { todayYmd } from "@/lib/dateUtils";
import { exportExcel } from "@/lib/excelUtils";
import ExcelButton from "@/components/ExcelButton";
import type { AttendanceRow } from "@/lib/attendance-rows";

// 응답 row 타입 (AttendanceCalendarView와 공유)
export interface CalendarEmployee {
  id: number;
  employeeNo: string;
  name: string;
  department: { id: number; name: string } | null;
  position: { name: string } | null;
}

export interface CalendarDaily {
  id: number;
  employeeId: number;
  workDate: string;
  checkIn: string | null;
  checkOut: string | null;
  originalCheckIn: string | null;
  originalCheckOut: string | null;
  autoStatus: string | null;
  categoryId: number | null;
  categoryCode: string | null;
  categoryName: string | null;
  isOverridden: boolean;
  workMinutes: number | null;
  note: string | null;
  statusReason?: string | null;
}

export interface CalendarRequest {
  id: number;
  employeeId: number;
  startDate: string;
  endDate: string;
  correctedCheckIn: string | null;
  correctedCheckOut: string | null;
  categoryCode: string | null;
  categoryName: string | null;
  reason: string | null;
}

interface ModalProps {
  date: string; // "YYYY-MM-DD"
  employees: CalendarEmployee[];
  requests: CalendarRequest[];
  rows: AttendanceRow[]; // 공용 조립 rows (일별 표시용)
  holidayName?: string | null; // Phase 6-2L+ B-4: 공휴일이면 이름
  editableEmployeeId?: number; // 이 직원 행이면 본인 사유 입력 가능 (내 근태에서 전달)
  onClose: () => void;
}

// 이 파일의 기존 폴백은 ""(빈문자열) — 출력 보존 위해 lib formatTime에 "" 전달
const formatTime = (iso: string | null) => libFormatTime(iso, "");

// 야간 근무가 자정을 넘긴 경우 시각 뒤에 "+1" 윗첨자를 붙인다.
function DayOffsetMark({
  workDate,
  iso,
}: {
  workDate: string | null | undefined;
  iso: string | null | undefined;
}) {
  const off = dayOffsetFromWorkDate(workDate, iso);
  if (off <= 0) return null;
  return (
    <sup
      className="ml-0.5 text-[10px] font-semibold text-amber-600"
      title={dayOffsetTitle(workDate, iso)}
    >
      +{off}
    </sup>
  );
}

function autoStatusLabel(s: string | null): string {
  if (s && s in AUTO_STATUS_META)
    return AUTO_STATUS_META[s as keyof typeof AUTO_STATUS_META].label;
  if (s === "working") return "근무중";
  return "-";
}

// Phase 6-2K: 한국어 날짜 라벨 ("2026년 6월 1일 (월)")
function formatDateKorean(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = ["일", "월", "화", "수", "목", "금", "토"][dt.getDay()];
  return `${y}년 ${m}월 ${d}일 (${dow})`;
}

// 평가 축(정상/지각/조퇴/결근)과 진행 축(근무중/미퇴근)은 서로 다른 축이므로
// 한쪽이 다른 쪽을 덮어쓰지 않고 함께 표시한다. 예: "🟡 지각 · 미퇴근"
const EVAL_BADGE: Record<string, { label: string; cls: string }> = {
  normal:      { label: `${EVAL_STATUS.normal.icon} ${EVAL_STATUS.normal.label}`,           cls: EVAL_STATUS.normal.cls },
  late:        { label: `${EVAL_STATUS.late.icon} ${EVAL_STATUS.late.label}`,               cls: EVAL_STATUS.late.cls },
  early_leave: { label: `${EVAL_STATUS.early_leave.icon} ${EVAL_STATUS.early_leave.label}`, cls: EVAL_STATUS.early_leave.cls },
  absent:      { label: `${EVAL_STATUS.absent.icon} ${EVAL_STATUS.absent.label}`,           cls: EVAL_STATUS.absent.cls },
};

function StatusBadge({
  autoStatus,
  checkIn,
  checkOut,
  isToday,
}: {
  autoStatus: string | null | undefined;
  checkIn: string | null;
  checkOut: string | null;
  isToday: boolean;
}) {
  // 평가 축 — 퇴근 기록 유무와 무관하게 항상 표시한다.
  const evalKey = autoStatus && autoStatus in EVAL_BADGE ? autoStatus : null;
  // 진행 축 — 출근O·퇴근X 일 때만. 오늘이면 근무중, 과거면 미퇴근.
  const progress = checkIn && !checkOut ? (isToday ? "근무중" : "미퇴근") : null;

  // 둘 다 있음 → 병기 (예: 야간 근무가 넘어가 퇴근이 아직 안 잡힌 지각자)
  if (evalKey && progress) {
    const e = EVAL_BADGE[evalKey];
    return (
      <span className={`text-xs font-medium whitespace-nowrap ${e.cls}`}>
        {e.label}
        <span className="text-gray-400"> · </span>
        <span className="text-gray-500">{progress}</span>
      </span>
    );
  }
  if (evalKey) {
    const e = EVAL_BADGE[evalKey];
    return <span className={`text-xs font-medium whitespace-nowrap ${e.cls}`}>{e.label}</span>;
  }
  if (progress) {
    const cls = progress === "근무중" ? "text-blue-600" : "text-amber-600";
    const icon = progress === "근무중" ? "🔵" : "🟠";
    return (
      <span className={`text-xs font-medium whitespace-nowrap ${cls}`}>{`${icon} ${progress}`}</span>
    );
  }
  // 평가·진행 둘 다 없음 — auto_status='working' 폴백 후 "-"
  if (autoStatus === "working") {
    return <span className="text-xs font-medium text-blue-600 whitespace-nowrap">🔵 근무중</span>;
  }
  return <span className="text-gray-400">-</span>;
}

// 폴백용(row=daily 없는 미래 일정 등): 요청의 정정/외근 시간대 라벨.
// 근태정정이면 "근태정정:", 그 외는 카테고리명(correctedRangeLabel).
function calendarTimeNote(req: CalendarRequest | undefined): string | null {
  if (!req || !req.correctedCheckIn || !req.correctedCheckOut) return null;
  const label = correctedRangeLabel(req.categoryCode, req.categoryName);
  return `${label}: ${formatTime(req.correctedCheckIn)}-${formatTime(req.correctedCheckOut)}`;
}

// 지각/조퇴 사유 첨부파일 (증빙) — 메타만 다루고 본문은 별도 GET으로 연다.
interface ReasonFileMeta {
  id: number;
  fileName: string;
  mimeType: string;
  fileSize: number | null;
  createdAt: string;
}

const REASON_FILE_ACCEPT =
  ".jpg,.jpeg,.png,.heic,.webp,.pdf,.hwp,.hwpx,.doc,.docx";
const REASON_FILE_MAX = 3;

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 첨부 칩 — 클릭하면 새 탭으로 열기(이미지/PDF 미리보기, hwp/doc은 다운로드) */
function ReasonFileChip({
  dailyId,
  file,
  onDelete,
  deleting,
}: {
  dailyId: number;
  file: ReasonFileMeta;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1 max-w-full bg-gray-100 border border-gray-200 rounded-full pl-2.5 pr-1 py-0.5 text-[11px] text-gray-700">
      <button
        type="button"
        onClick={() =>
          window.open(
            `/api/attendance-daily/${dailyId}/files/${file.id}`,
            "_blank",
            "noopener"
          )
        }
        className="truncate max-w-[160px] hover:text-blue-600 hover:underline"
        title={file.fileName}
      >
        {file.fileName}
      </button>
      <span className="text-gray-400 shrink-0">{formatFileSize(file.fileSize)}</span>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="p-0.5 rounded-full text-gray-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50 shrink-0"
          aria-label={`${file.fileName} 삭제`}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

/** 본인 행 전용 첨부 영역 (파일 선택 버튼 + 칩 목록) */
function ReasonFileUploader({
  dailyId,
  files,
  uploading,
  deletingId,
  onPick,
  onDelete,
}: {
  dailyId: number;
  files: ReasonFileMeta[];
  uploading: boolean;
  deletingId: number | null;
  onPick: (file: File) => void;
  onDelete: (fileId: number) => void;
}) {
  // 데스크탑/모바일에서 같은 행이 두 번 렌더되므로 input ref는 컴포넌트 인스턴스별로 둔다.
  const inputRef = useRef<HTMLInputElement>(null);
  const full = files.length >= REASON_FILE_MAX;

  return (
    <div className="mt-1.5">
      <input
        ref={inputRef}
        type="file"
        accept={REASON_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={full || uploading}
          title={full ? "첨부는 최대 3개까지 가능합니다." : undefined}
          className="px-2 py-1 text-[11px] font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 shrink-0"
        >
          {uploading ? "업로드중" : "파일 첨부"}
        </button>
        {files.map((f) => (
          <ReasonFileChip
            key={f.id}
            dailyId={dailyId}
            file={f}
            deleting={deletingId === f.id}
            onDelete={() => onDelete(f.id)}
          />
        ))}
      </div>
    </div>
  );
}

export default function AttendanceCalendarDayModal({
  date,
  employees,
  requests,
  rows,
  holidayName,
  editableEmployeeId,
  onClose,
}: ModalProps) {
  const [reasonEdits, setReasonEdits] = useState<Record<number, string>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [savedToast, setSavedToast] = useState("");
  // 저장 후 즉시 반영용 로컬 사유 오버라이드 (dailyId → reason)
  const [localReasons, setLocalReasons] = useState<Record<number, string | null>>({});
  // 지각/조퇴 사유 첨부파일 (dailyId → 메타 목록)
  const [reasonFiles, setReasonFiles] = useState<Record<number, ReasonFileMeta[]>>({});
  const [uploadingId, setUploadingId] = useState<number | null>(null);
  const [deletingFileId, setDeletingFileId] = useState<number | null>(null);

  // 모달이 열릴 때 지각/조퇴 행의 첨부 목록만 병렬 로드.
  // 권한 없음(403)/실패는 조용히 무시 — 해당 행 첨부 영역이 표시되지 않을 뿐.
  useEffect(() => {
    const targets = rows
      .filter(
        (r) =>
          r.workDate === date &&
          (r.autoStatus === "late" || r.autoStatus === "early_leave")
      )
      .map((r) => r.dailyId);
    if (targets.length === 0) return;

    let cancelled = false;
    Promise.all(
      targets.map(async (dailyId) => {
        try {
          const res = await fetch(`/api/attendance-daily/${dailyId}/files`);
          if (!res.ok) return null;
          const list = (await res.json()) as ReasonFileMeta[];
          return { dailyId, list };
        } catch {
          return null;
        }
      })
    ).then((results) => {
      if (cancelled) return;
      const next: Record<number, ReasonFileMeta[]> = {};
      for (const r of results) if (r) next[r.dailyId] = r.list;
      setReasonFiles((p) => ({ ...p, ...next }));
    });

    return () => {
      cancelled = true;
    };
  }, [rows, date]);

  const toast = (msg: string, ms = 2500) => {
    setSavedToast(msg);
    setTimeout(() => setSavedToast(""), ms);
  };

  // 첨부 업로드 — 성공 시 목록 즉시 갱신
  const uploadReasonFile = async (dailyId: number, file: File) => {
    setUploadingId(dailyId);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/attendance-daily/${dailyId}/files`, {
        method: "POST",
        body: fd,
      });
      if (res.ok) {
        const listRes = await fetch(`/api/attendance-daily/${dailyId}/files`);
        if (listRes.ok) {
          const list = (await listRes.json()) as ReasonFileMeta[];
          setReasonFiles((p) => ({ ...p, [dailyId]: list }));
        }
        toast("파일이 첨부되었습니다.", 2000);
      } else {
        const err = await res.json().catch(() => ({}));
        toast(err.error ?? "첨부 실패");
      }
    } catch {
      toast("네트워크 오류");
    } finally {
      setUploadingId(null);
    }
  };

  // 첨부 삭제
  const deleteReasonFile = async (dailyId: number, fileId: number) => {
    setDeletingFileId(fileId);
    try {
      const res = await fetch(
        `/api/attendance-daily/${dailyId}/files/${fileId}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        setReasonFiles((p) => ({
          ...p,
          [dailyId]: (p[dailyId] ?? []).filter((f) => f.id !== fileId),
        }));
        toast("첨부가 삭제되었습니다.", 2000);
      } else {
        const err = await res.json().catch(() => ({}));
        toast(err.error ?? "삭제 실패");
      }
    } catch {
      toast("네트워크 오류");
    } finally {
      setDeletingFileId(null);
    }
  };

  // 사유 저장 함수
  const saveReason = async (dailyId: number, value: string) => {
    setSavingId(dailyId);
    try {
      const res = await fetch(`/api/attendance-daily/${dailyId}/reason`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: value }),
      });
      if (res.ok) {
        setLocalReasons((p) => ({ ...p, [dailyId]: value.trim() || null }));
        setSavedToast("사유가 저장되었습니다.");
        setTimeout(() => setSavedToast(""), 2000);
      } else {
        const err = await res.json().catch(() => ({}));
        setSavedToast(err.error ?? "저장 실패");
        setTimeout(() => setSavedToast(""), 2500);
      }
    } catch {
      setSavedToast("네트워크 오류");
      setTimeout(() => setSavedToast(""), 2500);
    } finally {
      setSavingId(null);
    }
  };

  // 지각/조퇴 사유 영역 렌더 (데스크탑/모바일 공용) — row 기반
  const renderReason = (row: AttendanceRow | undefined, empId: number) => {
    const isLateOrEarly =
      row?.autoStatus === "late" || row?.autoStatus === "early_leave";
    if (!isLateOrEarly || row == null) return null;
    const canEdit = editableEmployeeId != null && empId === editableEmployeeId;
    const currentReason =
      row.dailyId in localReasons
        ? localReasons[row.dailyId] ?? ""
        : row.statusReason ?? "";
    const label = row.autoStatus === "late" ? "지각" : "조퇴";
    const files = reasonFiles[row.dailyId] ?? [];

    if (canEdit) {
      return (
        <div className="mt-1.5">
          <label className="block text-[11px] font-medium text-gray-500 mb-0.5">
            {label} 사유
          </label>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              defaultValue={currentReason}
              onChange={(e) =>
                setReasonEdits((p) => ({ ...p, [row.dailyId]: e.target.value }))
              }
              placeholder="사유를 입력하세요 (예: 병원 방문)"
              className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <button
              onClick={() =>
                saveReason(row.dailyId, reasonEdits[row.dailyId] ?? currentReason)
              }
              disabled={savingId === row.dailyId}
              className="px-2.5 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 shrink-0"
            >
              {savingId === row.dailyId ? "저장중" : "저장"}
            </button>
          </div>
          <ReasonFileUploader
            dailyId={row.dailyId}
            files={files}
            uploading={uploadingId === row.dailyId}
            deletingId={deletingFileId}
            onPick={(f) => uploadReasonFile(row.dailyId, f)}
            onDelete={(fileId) => deleteReasonFile(row.dailyId, fileId)}
          />
        </div>
      );
    }
    // 타인(관리자 조회) — 표시만. 첨부가 있으면 칩으로 열람 가능.
    const fileChips =
      files.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {files.map((f) => (
            <ReasonFileChip key={f.id} dailyId={row.dailyId} file={f} />
          ))}
        </div>
      ) : null;

    return currentReason ? (
      <div className="mt-1.5 text-xs text-gray-600">
        <span className="font-medium text-gray-500">{label} 사유:</span>{" "}
        {currentReason}
        {fileChips}
      </div>
    ) : (
      <div className="mt-1.5 text-xs text-gray-400">
        {label} 사유 미작성
        {fileChips}
      </div>
    );
  };

  // 모달 대상 날짜가 오늘(KST)인지 — 미퇴근/근무중 판정용
  const isToday = date === todayYmd();

  // 공용 조립 rows에서 해당 날짜 행을 직원별로 매핑
  const rowMap = new Map<number, AttendanceRow>();
  for (const r of rows) if (r.workDate === date) rowMap.set(r.employeeId, r);
  const dayData = employees.map((emp) => {
    const row = rowMap.get(emp.id);
    // req 는 row(=daily)가 없는 날짜(예: 미래 일정)의 폴백 표시용으로만 사용
    const req = row
      ? undefined
      : requests.find(
          (r) => r.employeeId === emp.id && r.startDate <= date && r.endDate >= date
        );
    return { emp, row, req };
  });

  const handleExportExcel = async () => {
    // Phase 6-2K: 출장/외근도 출퇴근 시간 함께 표시. 비고에 캘린더 시간 포함.
    const headers = [
      "직원번호",
      "이름",
      "부서",
      "출근",
      "퇴근",
      "상태/카테고리",
      "비고",
    ];
    const excelRows = dayData.map(({ emp, row, req }) => {
      // 대표요청 존재 여부: 모듈 reasonMap은 요청이 있으면 항상 ""(빈문자열) 이상을 set → null이면 요청 없음
      const hasReq = row ? row.reason !== null : !!req;
      const catName = row ? row.reqCategoryName : (req?.categoryName ?? null);
      // 비고 본문: row.reason은 빈문자열("")일 수 있으므로 || 로 폴백
      const reasonText = row ? (row.reason || row.note || "") : (req?.reason ?? "");
      const calNote = row
        ? (row.correctedCheckIn && row.correctedCheckOut
            ? `${correctedRangeLabel(row.reqCategoryCode, row.reqCategoryName)}: ${formatTime(row.correctedCheckIn)}-${formatTime(row.correctedCheckOut)}`
            : null)
        : calendarTimeNote(req);

      let inCell = "";
      let outCell = "";

      // 시간 — 카테고리 유무와 무관하게 attendance_daily에 시간이 있으면 표시
      if (row?.checkIn) {
        inCell = row.originalCheckIn
          ? `(${formatTime(row.originalCheckIn)}→)${formatTime(row.checkIn)}`
          : formatTime(row.checkIn);
      }
      if (row?.checkOut) {
        outCell = row.originalCheckOut
          ? `(${formatTime(row.originalCheckOut)}→)${formatTime(row.checkOut)}`
          : formatTime(row.checkOut);
        // 자정을 넘긴 퇴근은 근무일과 다른 날이므로 "(+1)"을 붙인다.
        const outOff = dayOffsetFromWorkDate(date, row.checkOut);
        if (outOff > 0) outCell += ` (+${outOff})`;
      }

      // 상태/카테고리 — 카테고리 우선, 없으면 autoStatus
      let statusCell = "";
      if (hasReq && catName) {
        statusCell = catName;
      } else {
        // 평가 축 + 진행 축 병기 — StatusBadge 와 동일 규칙
        const parts: string[] = [];
        if (row?.autoStatus && row.autoStatus in AUTO_STATUS_META) {
          parts.push(autoStatusLabel(row.autoStatus));
        }
        if (row?.checkIn && !row?.checkOut) {
          parts.push(isToday ? "근무중" : "미퇴근");
        }
        if (parts.length === 0 && row?.autoStatus) {
          parts.push(autoStatusLabel(row.autoStatus));
        }
        statusCell = parts.join(" · ");
      }
      if (row?.originalCheckIn || row?.originalCheckOut) statusCell += " (정정)";

      // 비고 — 캘린더 시간 + 사유/note
      const noteParts: string[] = [];
      if (calNote) noteParts.push(calNote);
      if (reasonText) noteParts.push(reasonText);
      const note = noteParts.join(" · ");

      // 모든 셀 null 안전 처리
      return [
        String(emp.employeeNo ?? ""),
        String(emp.name ?? ""),
        String(emp.department?.name ?? ""),
        String(inCell ?? ""),
        String(outCell ?? ""),
        String(statusCell ?? ""),
        String(note ?? ""),
      ];
    });

    await exportExcel(headers, excelRows, `근태_${date}.xlsx`, date);
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      {savedToast && (
        <div className="fixed bottom-6 right-6 z-[60] bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {savedToast}
        </div>
      )}
      <div
        className="bg-white rounded-2xl max-w-6xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-gray-100 px-4 sm:px-5 py-3 flex items-center justify-between z-10">
          {/* Phase 6-2K: 한국어 날짜 헤더 ("2026년 6월 1일 (월)") */}
          <h3 className="font-bold text-gray-900 text-base flex items-center gap-2">
            {formatDateKorean(date)}
            {/* Phase 6-2L+ B-4: 공휴일 라벨 (있을 때만) */}
            {holidayName && (
              <span className="text-xs font-semibold bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full">
                {holidayName}
              </span>
            )}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded"
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </div>

        {/* Phase 6-2K: 데스크탑 테이블 (sm 이상) */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead className="bg-gray-50 text-xs">
              <tr>
                <th className="px-3 py-2 text-left whitespace-nowrap">직원</th>
                <th className="px-3 py-2 text-left whitespace-nowrap">부서</th>
                <th className="px-3 py-2 text-left whitespace-nowrap">출근</th>
                <th className="px-3 py-2 text-left whitespace-nowrap">퇴근</th>
                <th className="px-3 py-2 text-left whitespace-nowrap">상태/카테고리</th>
                <th className="px-3 py-2 text-left whitespace-nowrap">비고</th>
              </tr>
            </thead>
            <tbody>
              {dayData.map(({ emp, row, req }) => {
                const hasReq = row ? row.reason !== null : !!req;
                const catName = row ? row.reqCategoryName : (req?.categoryName ?? null);
                const reasonText = row ? (row.reason || row.note || "") : (req?.reason ?? "");
                const calNote = row
                  ? (row.correctedCheckIn && row.correctedCheckOut
                      ? `${correctedRangeLabel(row.reqCategoryCode, row.reqCategoryName)}: ${formatTime(row.correctedCheckIn)}-${formatTime(row.correctedCheckOut)}`
                      : null)
                  : calendarTimeNote(req);
                return (
                  <tr
                    key={emp.id}
                    className="border-t border-gray-50 hover:bg-blue-50/30"
                  >
                    <td className="px-3 py-2.5 font-medium text-gray-900 whitespace-nowrap">
                      {emp.name}
                      <span className="ml-1 text-xs text-gray-400 font-mono">
                        {emp.employeeNo}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">
                      {emp.department?.name ?? "-"}
                    </td>
                    {/* Phase 6-2K: 출장/외근도 시간 표시 */}
                    <td className="px-3 py-2.5 font-mono whitespace-nowrap">
                      {row?.originalCheckIn ? (
                        <>
                          <span className="line-through text-gray-400 mr-1">
                            {formatTime(row.originalCheckIn)}
                          </span>
                          <span className="text-cyan-600 font-semibold">
                            {formatTime(row.checkIn)}
                          </span>
                        </>
                      ) : (
                        formatTime(row?.checkIn ?? null) || "-"
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono whitespace-nowrap">
                      {row?.originalCheckOut ? (
                        <>
                          <span className="line-through text-gray-400 mr-1">
                            {formatTime(row.originalCheckOut)}
                          </span>
                          <span className="text-cyan-600 font-semibold">
                            {formatTime(row.checkOut)}
                            <DayOffsetMark workDate={date} iso={row.checkOut} />
                          </span>
                        </>
                      ) : row?.checkOut ? (
                        <>
                          {formatTime(row.checkOut)}
                          <DayOffsetMark workDate={date} iso={row.checkOut} />
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {hasReq && catName ? (
                        <span className="text-purple-600 font-medium">
                          {catName}
                        </span>
                      ) : (
                        <StatusBadge autoStatus={row?.autoStatus ?? null} checkIn={row?.checkIn ?? null} checkOut={row?.checkOut ?? null} isToday={isToday} />
                      )}
                      {(row?.originalCheckIn || row?.originalCheckOut) && (
                        <span className="ml-1 text-xs bg-cyan-100 text-cyan-700 px-1.5 py-0.5 rounded-full font-medium">
                          정정
                        </span>
                      )}
                    </td>
                    {/* Phase 6-2K: 비고에 캘린더 시간 포함 */}
                    <td className="px-3 py-2.5 text-xs text-gray-500 w-full max-w-0">
                      {calNote && (
                        <span className="text-amber-600">{calNote}</span>
                      )}
                      {calNote && reasonText && " · "}
                      <span>{reasonText}</span>
                      {renderReason(row, emp.id)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Phase 6-2K: 모바일 카드 리스트 (sm 미만) */}
        <div className="sm:hidden space-y-2 p-3">
          {dayData.map(({ emp, row, req }) => {
            const hasReq = row ? row.reason !== null : !!req;
            const catName = row ? row.reqCategoryName : (req?.categoryName ?? null);
            const reasonText = row ? (row.reason || row.note || "") : (req?.reason ?? "");
            const calNote = row
              ? (row.correctedCheckIn && row.correctedCheckOut
                  ? `${correctedRangeLabel(row.reqCategoryCode, row.reqCategoryName)}: ${formatTime(row.correctedCheckIn)}-${formatTime(row.correctedCheckOut)}`
                  : null)
              : calendarTimeNote(req);
            const hasTimes = row?.checkIn || row?.checkOut;
            return (
              <div
                key={emp.id}
                className="bg-gray-50 rounded-lg p-3 space-y-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 text-sm truncate">
                      {emp.name}
                    </p>
                    <p className="text-xs text-gray-500">
                      {emp.department?.name ?? "-"}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {hasReq && catName ? (
                      <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">
                        {catName}
                      </span>
                    ) : (
                      <StatusBadge autoStatus={row?.autoStatus ?? null} checkIn={row?.checkIn ?? null} checkOut={row?.checkOut ?? null} isToday={isToday} />
                    )}
                  </div>
                </div>

                {hasTimes && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono">
                    <span>
                      출근:{" "}
                      {row?.originalCheckIn ? (
                        <>
                          <span className="line-through text-gray-400">
                            {formatTime(row.originalCheckIn)}
                          </span>{" "}
                          <span className="text-cyan-600">
                            {formatTime(row.checkIn)}
                          </span>
                        </>
                      ) : (
                        formatTime(row?.checkIn ?? null) || "-"
                      )}
                    </span>
                    <span>
                      퇴근:{" "}
                      {row?.originalCheckOut ? (
                        <>
                          <span className="line-through text-gray-400">
                            {formatTime(row.originalCheckOut)}
                          </span>{" "}
                          <span className="text-cyan-600">
                            {formatTime(row.checkOut)}
                            <DayOffsetMark workDate={date} iso={row.checkOut} />
                          </span>
                        </>
                      ) : (
                        <>
                          {formatTime(row?.checkOut ?? null) || "-"}
                          <DayOffsetMark workDate={date} iso={row?.checkOut} />
                        </>
                      )}
                    </span>
                  </div>
                )}

                {calNote && (
                  <p className="text-xs text-amber-600">{calNote}</p>
                )}
                {reasonText && (
                  <p className="text-xs text-gray-500">{reasonText}</p>
                )}
                {renderReason(row, emp.id)}
              </div>
            );
          })}
        </div>

        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-4 sm:px-5 py-3 flex justify-end">
          {/* 일별 근태 Excel 다운로드 */}
          <ExcelButton
            onClick={handleExportExcel}
            disabled={dayData.length === 0}
            size="sm"
          />
        </div>
      </div>
    </div>
  );
}
