"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Plus,
  Edit,
  X,
  ClipboardList,
  Calendar,
  Clock,
  AlertCircle,
  Loader2,
  CheckCircle,
  XCircle,
  FileText,
  CalendarDays,
  CheckCircle2,
  Wallet,
} from "lucide-react";
import { useCurrentEmployee } from "@/lib/useCurrentEmployee";
import { buildMemoHeader, extractMemoNotes, composeMemo } from "@/lib/calendar-memo";
import { exportExcel } from "@/lib/excelUtils";
import ExcelButton from "@/components/ExcelButton";
import DatePicker from "@/components/DatePicker";
import TimePicker from "@/components/TimePicker";
import { todayYmd } from "@/lib/dateUtils";

interface AttendanceRequest {
  id: number;
  employeeId: number;
  categoryId: number;
  categoryCode: string;
  categoryName: string;
  categoryType: string;
  categoryColor: string | null;
  requestType: string;
  startDate: string;
  endDate: string;
  reason: string | null;
  correctedCheckIn: string | null;
  correctedCheckOut: string | null;
  status: string;
  primaryApproverId: number | null;
  primaryApproverName: string | null;
  deputyApproverId: number | null;
  deputyApproverName: string | null;
  approvedById: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  requestedAt: string;
  // Phase 6-2E 캘린더 등록 정보
  calendarSourceId: number | null;
  calendarEventTitle: string | null;
  calendarEventDescription: string | null;
  externalSource: string | null;
  externalEventId: string | null;
}

interface CalendarSourceOption {
  id: number;
  calendarId: string;
  calendarName: string;
  defaultCategoryId: number;
  // Phase 6-2L: N:M 매핑용 (휴가류 5개 → VanaM_Vacation 같은 경우)
  categoryIds: number[];
  description: string | null;
}

interface CategoryOption {
  id: number;
  code: string;
  name: string;
  type: string;
  displayColor: string | null;
  requireApproval: boolean;
}

interface StatusLookup {
  code: string;
  label: string;
  color: string | null;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate()
  )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ISO 문자열에서 시간만 "HH:MM" 형태로 추출 (시간대 변환 후 로컬 시간 기준)
function isoToTimeInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 일수 포맷: 정수면 그대로, 아니면 소수 1자리 (반차 0.5 단위 대응)
function fmtDays(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const EMPTY_FORM = {
  categoryId: "" as "" | string,
  startDate: todayYmd(),
  endDate: todayYmd(),
  reason: "",
  correctedCheckIn: "",
  correctedCheckOut: "",
  correctionType: "both" as "in_only" | "out_only" | "both",
  // Phase 6-2E 캘린더 등록 정보
  calendarSourceId: "" as "" | string,
  calendarEventTitle: "",
  calendarEventDescription: "",
};

// Phase 6-2F: 시간 입력 정책
// - 종일 강제 카테고리: 연차(ANNUAL) — 시간 입력란 숨김, 항상 종일 등록
// - 그 외(반차/병가/외근/출장/재택/기타 등): 시간 입력란 표시, 빈칸 = 종일
const CATEGORIES_WITHOUT_TIME = new Set(["ANNUAL"]);

// 휴가/근태 신청 탭에서 숨길 카테고리(출장/외근은 "출장/외근 관리" 탭에서 생성). 재택(REMOTE_WORK)은 유지.
const HIDDEN_REQUEST_CATEGORY_CODES = new Set(["EXTERNAL_WORK", "BUSINESS_TRIP"]);

// 반차 시간 기본값 (사용자 수정 가능)
const HALF_DAY_DEFAULTS: Record<string, { in: string; out: string }> = {
  HALF_AM: { in: "09:00", out: "13:00" },
  HALF_PM: { in: "13:00", out: "18:00" },
};

// 카테고리 코드별 시간 입력 정책 헬퍼
function categoryAllowsTimeInput(code: string | undefined | null): boolean {
  if (!code) return false;
  return !CATEGORIES_WITHOUT_TIME.has(code);
}

export default function RequestPage() {
  const { currentId, current, me, loading: empLoading } = useCurrentEmployee();

  const [requests, setRequests] = useState<AttendanceRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");

  // 본인 연차 현황 (전체/사용/잔여)
  const [leaveInfo, setLeaveInfo] = useState<{
    granted: number; used: number; remaining: number; mapped: boolean;
  } | null>(null);

  // 신청 폼 연차 차감 미리보기 (선택 항목·기간 기준, 서버 재계산)
  const [preview, setPreview] = useState<{
    deductPerDay: number; businessDays: number; requestAmount: number;
    granted: number; remaining: number; remainingAfter: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/annual-leave/my");
        if (res.ok) {
          const d = await res.json();
          if (!cancelled) setLeaveInfo(d);
        }
      } catch (e) {
        console.error("my leave fetch error:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [currentId]);

  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [statusLookups, setStatusLookups] = useState<StatusLookup[]>([]);
  // Phase 6-2E 캘린더 옵션
  const [calendarSources, setCalendarSources] = useState<CalendarSourceOption[]>([]);

  // Phase 6-2L-fix-3: 자동채움은 카테고리가 "새로 선택"된 경우 1회만.
  // 카테고리가 이전에 자동채움된 값과 다를 때만 캘린더/제목/설명/반차시간 기본값 제안.
  // 사용자가 캘린더를 직접 바꾸거나 시간을 직접 수정한 후에는 자동값으로 되돌아가지 않음.
  const lastAutoFilledCategoryRef = useRef<string | null>(null);

  // Phase 6-2F: 본인 부서 + 결재선 존재 여부 (신청 가능 여부 결정)
  // - 부서 없음: me.departmentId === null → 즉시 차단
  // - 결재선 체크: /api/approval-lines는 admin만 호출 가능. 일반 직원은 낙관적 통과
  //   (API POST가 카테고리별로 추가 검증함)
  const [approvalLineStatus, setApprovalLineStatus] = useState<{
    hasDepartment: boolean;
    hasApprovalLine: boolean;
    loading: boolean;
  }>({ hasDepartment: true, hasApprovalLine: true, loading: true });

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<AttendanceRequest | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  // 정정 — 선택한 날의 현재 attendance_daily 기록
  const [currentDaily, setCurrentDaily] = useState<{
    workDate: string;
    checkIn: string | null;
    checkOut: string | null;
    autoStatus: string | null;
    workMinutes: number | null;
    isOverridden: boolean;
  } | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyFetched, setDailyFetched] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // 마스터 1회 로드
  useEffect(() => {
    (async () => {
      try {
        const [cRes, sRes] = await Promise.all([
          fetch("/api/categories?includeInactive=false"),
          fetch("/api/lookups?category=request_status&includeInactive=false"),
        ]);
        if (cRes.ok) {
          const data = await cRes.json();
          setCategories(
            data
              .map((c: any) => ({
                id: c.id,
                code: c.code,
                name: c.name,
                type: c.type,
                displayColor: c.displayColor,
                requireApproval: c.requireApproval,
              }))
              .filter(
                (c: { code: string }) =>
                  !HIDDEN_REQUEST_CATEGORY_CODES.has(c.code)
              )
          );
        }
        if (sRes.ok) setStatusLookups(await sRes.json());
      } catch (e) {
        console.error("masters fetch error:", e);
      }
    })();
  }, []);

  // Phase 6-2E 캘린더 소스 로드 (1회)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/calendar-sources");
        if (res.ok) {
          setCalendarSources(await res.json());
        }
      } catch (e) {
        console.error("calendar-sources fetch error:", e);
      }
    })();
  }, []);

  // Phase 6-2F: 부서 + 결재선 존재 여부 체크
  // ADMIN/CEO는 백엔드에서 자동승인되므로 부서/결재선 없이도 신청 허용.
  useEffect(() => {
    if (!me) return;

    // ADMIN/CEO는 결재 불필요(자동승인) → 항상 통과
    if (me.isAdmin || me.isCeo) {
      setApprovalLineStatus({
        hasDepartment: true,
        hasApprovalLine: true,
        loading: false,
      });
      return;
    }

    const departmentId = me.departmentId;
    if (!departmentId) {
      // 일반 직원 + 부서 없음 → 부서는 없지만, fallback 결재자가 있으면 신청 가능.
      // /api/policy/fallback-approver로 fallback 존재 여부 확인.
      // (주의: 이 엔드포인트는 admin 전용이라 일반 직원은 403 → 보수적으로 차단됨)
      fetch("/api/policy/fallback-approver")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          // 응답 형태: { employeeId, employeeNo, name, isActive }
          // employeeId가 있으면 fallback 결재자 존재로 간주
          const hasFallback = !!(data && data.employeeId);
          setApprovalLineStatus({
            hasDepartment: hasFallback,   // fallback 있으면 통과시키기 위해 true로 둠
            hasApprovalLine: hasFallback,
            loading: false,
          });
        })
        .catch(() => {
          // 조회 실패 시 기존처럼 차단(안전)
          setApprovalLineStatus({
            hasDepartment: false,
            hasApprovalLine: false,
            loading: false,
          });
        });
      return;
    }

    // 결재선 체크 — admin만 호출 가능. 일반 직원은 403 → 낙관적 통과 (API POST가 추가 검증).
    fetch("/api/approval-lines")
      .then((r) => {
        if (r.status === 403 || !r.ok) return null;
        return r.json();
      })
      .then((data) => {
        if (data == null) {
          // 응답 없음(403 또는 에러) → 부서는 있으므로 일단 낙관적 통과
          setApprovalLineStatus({
            hasDepartment: true,
            hasApprovalLine: true,
            loading: false,
          });
          return;
        }
        // admin이 가져온 전체 결재선 중 본인 부서 매칭 찾기
        const myLine = Array.isArray(data)
          ? data.find(
              (l: { departmentId: number; primaryApproverId: number | null }) =>
                l.departmentId === departmentId
            )
          : null;
        const hasLine = !!(myLine && myLine.primaryApproverId);
        setApprovalLineStatus({
          hasDepartment: true,
          hasApprovalLine: hasLine,
          loading: false,
        });
      })
      .catch(() => {
        // 네트워크 오류 — 낙관적 통과 (POST API가 최종 검증)
        setApprovalLineStatus({
          hasDepartment: true,
          hasApprovalLine: true,
          loading: false,
        });
      });
  }, [me]);

  const fetchRequests = useCallback(async () => {
    if (!currentId) {
      setRequests([]);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("employeeId", String(currentId));
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/attendance-requests?${params}`);
      if (res.ok) setRequests(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentId, statusFilter]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // 정정 카테고리 + 날짜 변경 시 그 날 attendance_daily 자동 fetch
  useEffect(() => {
    const selCat = categories.find((c) => c.id === Number(form.categoryId));
    if (!showForm || !currentId || selCat?.type !== "correction" || !form.startDate) {
      setCurrentDaily(null);
      setDailyFetched(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setDailyLoading(true);
      setDailyFetched(false);
      try {
        const params = new URLSearchParams();
        params.set("employeeId", String(currentId));
        params.set("from", form.startDate);
        params.set("to", form.startDate);
        const res = await fetch(`/api/attendance-daily?${params}`);
        if (cancelled) return;
        if (res.ok) {
          const list = await res.json();
          setCurrentDaily(list.length > 0 ? list[0] : null);
        } else {
          setCurrentDaily(null);
        }
        setDailyFetched(true);
      } catch {
        if (!cancelled) {
          setCurrentDaily(null);
          setDailyFetched(true);
        }
      } finally {
        if (!cancelled) setDailyLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showForm, currentId, form.categoryId, form.startDate, categories]);

  // Phase 6-2L-fix-3: 자동채움은 "카테고리 새로 선택" 시 1회만.
  // - lastAutoFilledCategoryRef와 form.categoryId가 다르면 자동채움 1회 실행 후 ref 갱신
  // - 캘린더 직접 변경/사유/날짜/시간 수정에는 다시 트리거하지 않음 (사용자 수정 존중)
  // - 매칭 실패 시 calendarSourceId를 빈 값으로 강제하지 않음 (사용자가 직접 고를 수 있게)
  // - 수정 모드(editTarget≠null)에서는 자동채움 안 함
  useEffect(() => {
    if (!showForm) return;
    if (editTarget) return; // 수정 모드: 자동채움 skip
    const catId = form.categoryId;
    if (!catId) return; // 카테고리 미선택
    const cat = categories.find((c) => c.id === Number(catId));
    if (!cat) return; // 마스터 로드 전
    if (cat.type === "correction") {
      // 정정은 캘린더 등록 대상 아님 — 자동채움 대상 아님. ref만 갱신해 다른 자동값으로 안 되돌아가게.
      lastAutoFilledCategoryRef.current = String(catId);
      return;
    }
    // ⭐ 핵심 가드: 직전 자동채움 카테고리와 같으면 skip (캘린더/시간 사용자 수정 보존)
    if (lastAutoFilledCategoryRef.current === String(catId)) return;

    // ── 1) 캘린더 자동 매칭 (N:M categoryIds 우선, fallback defaultCategoryId)
    //    매칭 실패 시 빈 값으로 강제하지 않고 사용자가 직접 고를 수 있게 둔다.
    const categoryIdNum = Number(catId);
    let matched = calendarSources.find(
      (cs) =>
        Array.isArray(cs.categoryIds) &&
        cs.categoryIds.includes(categoryIdNum)
    );
    if (!matched) {
      matched = calendarSources.find(
        (cs) => cs.defaultCategoryId === categoryIdNum
      );
    }
    const suggestedSourceId = matched ? String(matched.id) : null;

    // ── 2) 제목/설명 자동
    const empName = current?.name ?? "";
    const autoTitle = empName ? `[${cat.name}] ${empName}` : `[${cat.name}]`;
    const lines = [
      "[VanaM HR 자동 등록]",
      `신청자: ${empName || "-"}` +
        (current?.departmentName ? ` (${current.departmentName})` : ""),
      `카테고리: ${cat.name}`,
    ].filter(Boolean);
    const autoDesc = lines.join("\n");

    // ── 3) 반차 시간 기본값 (HALF_AM/HALF_PM)
    const halfDayDefault = HALF_DAY_DEFAULTS[cat.code];

    setForm((f) => {
      const next = { ...f };
      // 캘린더: 매칭됐을 때만 제안. 사용자가 이미 다른 값을 선택했어도 카테고리가 새로 바뀐
      //         시점이므로 매칭값으로 제안. 매칭이 없으면(suggestedSourceId === null)
      //         사용자 기존 선택을 그대로 둔다 (덮어쓰기 X).
      if (suggestedSourceId !== null && f.calendarSourceId !== suggestedSourceId) {
        next.calendarSourceId = suggestedSourceId;
      }
      next.calendarEventTitle = autoTitle;
      next.calendarEventDescription = composeMemo(
        autoDesc,
        extractMemoNotes(f.calendarEventDescription)
      );
      // 시간: 반차면 기본값, 연차(시간불가)면 클리어, 그 외는 사용자 입력 유지
      if (halfDayDefault) {
        next.correctedCheckIn = halfDayDefault.in;
        next.correctedCheckOut = halfDayDefault.out;
      } else if (!categoryAllowsTimeInput(cat.code)) {
        next.correctedCheckIn = "";
        next.correctedCheckOut = "";
      }
      return next;
    });

    // 자동채움 완료 — ref 갱신 (다음 카테고리 변경까지 자동채움 1회로 한정)
    lastAutoFilledCategoryRef.current = String(catId);
    // 의존성: 카테고리/마스터 데이터/edit 모드. calendarSourceId는 일부러 제외 —
    // 사용자가 캘린더만 바꿔도 자동채움이 다시 일어나지 않게.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showForm,
    form.categoryId,
    categories,
    calendarSources,
    current,
    editTarget,
  ]);

  // status / category helper
  const getStatusLabel = (code: string): string => {
    const lookup = statusLookups.find((l) => l.code === code);
    return lookup ? lookup.label : code;
  };
  const getStatusColor = (code: string): string | null => {
    const lookup = statusLookups.find((l) => l.code === code);
    return lookup?.color ?? null;
  };

  const selectedCategory = useMemo(
    () =>
      categories.find((c) => c.id === Number(form.categoryId)) ?? null,
    [categories, form.categoryId]
  );

  // 연차 차감 미리보기 — 항목/기간 변경 시 debounce로 서버 조회 (서버 초과 차단과 동일 계산)
  useEffect(() => {
    const isCorrection = selectedCategory?.type === "correction";
    if (!form.categoryId || !form.startDate || !form.endDate
        || form.endDate < form.startDate || isCorrection) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/annual-leave/preview?categoryId=${Number(form.categoryId)}` +
          `&startDate=${form.startDate}&endDate=${form.endDate}`
        );
        if (res.ok) {
          const d = await res.json();
          if (!cancelled) setPreview(d.mapped ? d : null);
        } else if (!cancelled) {
          setPreview(null);
        }
      } catch {
        if (!cancelled) setPreview(null);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [form.categoryId, form.startDate, form.endDate, selectedCategory?.type]);

  const memoHeader = useMemo(
    () =>
      buildMemoHeader({
        name: current?.name,
        dept: current?.departmentName,
        categoryName: selectedCategory?.name ?? "",
      }),
    [current, selectedCategory]
  );

  const openCreate = () => {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setFormError("");
    // Phase 6-2L-fix-3: 새 신청 → 자동채움 트래커 초기화
    // (사용자가 처음 카테고리를 고를 때 자동채움이 1회 동작하도록)
    lastAutoFilledCategoryRef.current = null;
    setShowForm(true);
  };

  const openEdit = (r: AttendanceRequest) => {
    if (r.status !== "pending") return;
    setEditTarget(r);

    // 정정 종류 추론
    let inferredType: "in_only" | "out_only" | "both" = "both";
    if (r.categoryType === "correction") {
      if (r.correctedCheckIn && !r.correctedCheckOut) inferredType = "in_only";
      else if (!r.correctedCheckIn && r.correctedCheckOut) inferredType = "out_only";
    }

    setForm({
      categoryId: String(r.categoryId),
      startDate: r.startDate,
      endDate: r.endDate,
      reason: r.reason || "",
      correctedCheckIn: isoToTimeInput(r.correctedCheckIn),
      correctedCheckOut: isoToTimeInput(r.correctedCheckOut),
      correctionType: inferredType,
      // Phase 6-2E 캘린더 필드 (있으면 그대로 로드)
      calendarSourceId: r.calendarSourceId != null ? String(r.calendarSourceId) : "",
      calendarEventTitle: r.calendarEventTitle ?? "",
      calendarEventDescription: r.calendarEventDescription ?? "",
    });
    setFormError("");
    // Phase 6-2L-fix-3: 수정 모드에서는 자동채움 안 함. 카테고리 추적 ref도 현재값으로 고정.
    lastAutoFilledCategoryRef.current = String(r.categoryId);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!currentId) return;
    if (!form.categoryId) {
      setFormError("근태 항목을 선택하세요.");
      return;
    }
    if (!form.startDate || !form.endDate) {
      setFormError("시작일과 종료일을 입력하세요.");
      return;
    }
    if (form.endDate < form.startDate) {
      setFormError("종료일은 시작일 이후여야 합니다.");
      return;
    }
    if (selectedCategory?.type === "correction") {
      // 단일 날짜 강제
      if (form.startDate !== form.endDate) {
        setFormError("정정은 단일 날짜만 가능합니다.");
        return;
      }
      // 정정 종류별 검증
      const needIn = form.correctionType === "in_only" || form.correctionType === "both";
      const needOut = form.correctionType === "out_only" || form.correctionType === "both";
      if (needIn && !form.correctedCheckIn) {
        setFormError("새 출근 시각을 입력하세요.");
        return;
      }
      if (needOut && !form.correctedCheckOut) {
        setFormError("새 퇴근 시각을 입력하세요.");
        return;
      }
      if (needIn && needOut && form.correctedCheckOut && form.correctedCheckIn) {
        if (form.correctedCheckOut <= form.correctedCheckIn) {
          setFormError("정정 퇴근 시각은 정정 출근 시각 이후여야 합니다.");
          return;
        }
      }
    } else if (
      // Phase 6-2G: 정정 외 + 시간 입력 허용 카테고리에서 시간 한쪽만 입력 차단
      selectedCategory &&
      categoryAllowsTimeInput(selectedCategory.code)
    ) {
      const inFilled = !!form.correctedCheckIn?.trim();
      const outFilled = !!form.correctedCheckOut?.trim();
      if (inFilled !== outFilled) {
        setFormError(
          "시작 시간과 종료 시간을 모두 입력하거나, 모두 비워주세요. (모두 비우면 종일 일정으로 등록됩니다.)"
        );
        return;
      }
    }

    // 연차 잔여 소프트 가드 (UX용 — 최종 판정은 서버 초과 차단)
    if (preview && preview.deductPerDay > 0 && preview.remainingAfter < 0) {
      setFormError(
        `연차 잔여가 부족합니다. (신청 ${fmtDays(preview.requestAmount)}일 / 잔여 ${fmtDays(preview.remaining)}일)`
      );
      return;
    }

    setFormError("");
    setSaving(true);
    try {
      const url = editTarget
        ? `/api/attendance-requests?id=${editTarget.id}`
        : "/api/attendance-requests";
      const method = editTarget ? "PUT" : "POST";

      const payload: any = {
        employeeId: currentId,
        categoryId: Number(form.categoryId),
        startDate: form.startDate,
        endDate: form.endDate,
        reason: form.reason.trim() || null,
      };
      if (selectedCategory?.type === "correction") {
        const needIn = form.correctionType === "in_only" || form.correctionType === "both";
        const needOut = form.correctionType === "out_only" || form.correctionType === "both";
        // form.startDate (YYYY-MM-DD) + form.correctedCheckIn (HH:MM) → ISO
        payload.correctedCheckIn = needIn && form.correctedCheckIn
          ? `${form.startDate}T${form.correctedCheckIn}:00`
          : null;
        payload.correctedCheckOut = needOut && form.correctedCheckOut
          ? `${form.startDate}T${form.correctedCheckOut}:00`
          : null;
      } else if (categoryAllowsTimeInput(selectedCategory?.code)) {
        // Phase 6-2F: 연차 외 카테고리는 시간 입력 옵션 (비우면 종일, 채우면 다일 가능)
        // 시작 시간 → startDate에 붙임, 종료 시간 → endDate에 붙임 (다일 일정 지원)
        payload.correctedCheckIn = form.correctedCheckIn
          ? `${form.startDate}T${form.correctedCheckIn}:00`
          : null;
        payload.correctedCheckOut = form.correctedCheckOut
          ? `${form.endDate}T${form.correctedCheckOut}:00`
          : null;
      } else {
        // 연차(ANNUAL) — 항상 종일
        payload.correctedCheckIn = null;
        payload.correctedCheckOut = null;
      }

      // Phase 6-2E 캘린더 정보 (선택)
      // 정정 카테고리는 캘린더 등록 대상이 아니므로 모두 NULL로 전송
      if (selectedCategory?.type === "correction") {
        payload.calendarSourceId = null;
        payload.calendarEventTitle = null;
        payload.calendarEventDescription = null;
      } else if (form.calendarSourceId) {
        payload.calendarSourceId = Number(form.calendarSourceId);
        payload.calendarEventTitle = form.calendarEventTitle.trim() || null;
        payload.calendarEventDescription =
          form.calendarEventDescription.trim() || null;
      } else {
        payload.calendarSourceId = null;
        payload.calendarEventTitle = null;
        payload.calendarEventDescription = null;
      }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "저장 실패");
        return;
      }
      showToast(
        "✅ " +
          (editTarget
            ? "수정되었습니다"
            : data.status === "auto_approved"
            ? "자동 승인 완료"
            : "신청되었습니다")
      );
      setShowForm(false);
      fetchRequests();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async (r: AttendanceRequest) => {
    if (!currentId) return;
    if (
      !confirm(
        `"${r.categoryName}" 결재 요청을 취소하시겠습니까?\n취소 후에는 복구할 수 없습니다.`
      )
    )
      return;
    try {
      const res = await fetch(`/api/attendance-requests?id=${r.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: currentId, action: "cancel" }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "취소 실패");
        return;
      }
      showToast("✅ 취소되었습니다");
      fetchRequests();
    } catch {
      alert("네트워크 오류");
    }
  };

  // 출장/외근은 "출장 및 외근 관리" 탭에서 다루므로 이 목록에선 제외(신청 폼과 동일 기준).
  const visibleRequests = requests.filter(
    (r) => !HIDDEN_REQUEST_CATEGORY_CODES.has(r.categoryCode)
  );

  const handleExportExcel = async () => {
    if (visibleRequests.length === 0) return;
    await exportExcel(
      ["근태항목", "유형", "시작일", "종료일", "사유", "상태", "결재자", "등록일"],
      visibleRequests.map((r) => [
        r.categoryName,
        r.categoryType,
        r.startDate,
        r.endDate,
        r.reason ?? "",
        getStatusLabel(r.status),
        r.approvedByName ??
          r.primaryApproverName ??
          (r.status === "auto_approved" ? "자동 승인" : ""),
        new Date(r.requestedAt).toLocaleString("ko-KR"),
      ]),
      `결재요청_${todayYmd()}.xlsx`,
      "결재요청"
    );
  };

  // status 배지 스타일
  function statusBadge(code: string) {
    const color = getStatusColor(code);
    if (color && color.startsWith("#")) {
      return {
        backgroundColor: `${color}20`,
        color,
      };
    }
    return { backgroundColor: "#f3f4f6", color: "#4b5563" };
  }

  // Phase 6-2F: 부서/결재선 체크 통과 + 본인 선택 시에만 신청 가능
  const blockedByApprovalLine =
    !approvalLineStatus.loading &&
    (!approvalLineStatus.hasDepartment || !approvalLineStatus.hasApprovalLine);
  const canRequest = currentId !== null && !blockedByApprovalLine;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 토스트 */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            휴가 및 근태 신청
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {current
              ? `${current.name} 님의 결재 요청`
              : "본인을 선택하세요"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExcelButton
            onClick={handleExportExcel}
            disabled={visibleRequests.length === 0}
          />
          <button
            onClick={openCreate}
            disabled={!canRequest || categories.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              currentId === null
                ? "본인을 선택하세요"
                : blockedByApprovalLine
                ? "부서/결재선 설정이 필요합니다"
                : categories.length === 0
                ? "활성 근태 항목이 없습니다"
                : ""
            }
          >
            <Plus size={16} />
            결재 신청
          </button>
        </div>
      </div>

      {/* 본인 연차 현황 */}
      {leaveInfo && leaveInfo.mapped && (
        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          {/* 전체 연차 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center mb-3">
              <CalendarDays size={18} className="text-blue-600" />
            </div>
            <p className="text-xs text-gray-500">올해 전체 연차</p>
            <p className="text-2xl font-bold text-gray-900 mt-0.5">
              {leaveInfo.granted.toFixed(leaveInfo.granted % 1 === 0 ? 0 : 1)}
              <span className="text-sm font-medium text-gray-400 ml-1">일</span>
            </p>
          </div>
          {/* 사용 연차 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center mb-3">
              <CheckCircle2 size={18} className="text-amber-600" />
            </div>
            <p className="text-xs text-gray-500">사용한 연차</p>
            <p className="text-2xl font-bold text-gray-900 mt-0.5">
              {leaveInfo.used.toFixed(leaveInfo.used % 1 === 0 ? 0 : 1)}
              <span className="text-sm font-medium text-gray-400 ml-1">일</span>
            </p>
          </div>
          {/* 잔여 연차 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center mb-3">
              <Wallet size={18} className="text-emerald-600" />
            </div>
            <p className="text-xs text-gray-500">잔여 연차</p>
            <p className="text-2xl font-bold text-emerald-700 mt-0.5">
              {leaveInfo.remaining.toFixed(leaveInfo.remaining % 1 === 0 ? 0 : 1)}
              <span className="text-sm font-medium text-emerald-400 ml-1">일</span>
            </p>
          </div>
        </div>
      )}

      {/* Phase 6-2F: 부서/결재선 없음 안내 (본인이 매핑된 경우만 표시) */}
      {currentId !== null && blockedByApprovalLine && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-xl">
          <div className="flex items-start gap-2">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold mb-1">신청을 진행할 수 없습니다</p>
              <p>
                {!approvalLineStatus.hasDepartment
                  ? "본인 계정에 부서가 지정되지 않았습니다. "
                  : "본인 부서에 결재선이 설정되지 않았습니다. "}
                관리자에게 요청하세요.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 본인 없음 */}
      {empLoading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : !currentId ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center text-sm text-gray-400 flex flex-col items-center gap-3">
          <AlertCircle size={24} className="text-gray-300" />
          본인을 선택하세요
        </div>
      ) : (
        <>
          {/* 등록 / 수정 폼 */}
          {showForm && (
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-blue-900">
                  {editTarget ? "결재 요청 수정" : "결재 신청"}
                </h2>
                <button
                  onClick={() => setShowForm(false)}
                  className="text-blue-400 hover:text-blue-700"
                >
                  <X size={18} />
                </button>
              </div>

              {/* 근태 항목 */}
              <div>
                <label className="block text-xs font-semibold text-blue-700 mb-1">
                  근태 항목 <span className="text-rose-500">*</span>
                </label>
                <select
                  value={form.categoryId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, categoryId: e.target.value }))
                  }
                  className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                >
                  <option value="">(선택)</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
              </div>

              {/* 자동 승인 안내 */}
              {selectedCategory && (
                <div
                  className={`px-3 py-2 rounded-xl text-xs ${
                    selectedCategory.requireApproval
                      ? "bg-blue-100 text-blue-800"
                      : "bg-amber-50 border border-amber-200 text-amber-800"
                  }`}
                >
                  {selectedCategory.requireApproval ? (
                    <>
                      <CheckCircle size={12} className="inline mr-1 -translate-y-px" />
                      이 항목은 결재가 필요합니다. 신청 후 결재자 승인 대기 상태가 됩니다.
                    </>
                  ) : (
                    <>
                      <AlertCircle size={12} className="inline mr-1 -translate-y-px" />
                      이 항목은 자동 승인됩니다. 결재 절차 없이 즉시 등록됩니다.
                    </>
                  )}
                </div>
              )}

              {/* 정정 종류 라디오 (correction 타입만) */}
              {selectedCategory?.type === "correction" && (
                <div className="bg-white border border-blue-200 rounded-xl p-3 space-y-2">
                  <label className="block text-xs font-semibold text-blue-700">
                    정정 종류 <span className="text-rose-500">*</span>
                  </label>
                  <div className="flex gap-2">
                    {[
                      { value: "in_only", label: "출근만" },
                      { value: "out_only", label: "퇴근만" },
                      { value: "both", label: "출근/퇴근" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            correctionType: opt.value as "in_only" | "out_only" | "both",
                            // 종류 변경 시 사용 안 하는 시각 비움
                            correctedCheckIn:
                              opt.value === "out_only" ? "" : f.correctedCheckIn,
                            correctedCheckOut:
                              opt.value === "in_only" ? "" : f.correctedCheckOut,
                          }))
                        }
                        className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${
                          form.correctionType === opt.value
                            ? "bg-blue-500 text-white border-blue-500"
                            : "bg-white text-blue-700 border-blue-200 hover:bg-blue-50"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 기간 — correction이면 단일 날짜, 그 외는 시작/종료 두 개 */}
              {selectedCategory?.type === "correction" ? (
                <div>
                  <label className="block text-xs font-semibold text-blue-700 mb-1">
                    정정할 날짜 <span className="text-rose-500">*</span>
                  </label>
                  <DatePicker
                    value={form.startDate}
                    max={todayYmd()}
                    placeholder="정정할 날짜 선택"
                    onChange={(val) =>
                      setForm((f) => ({ ...f, startDate: val, endDate: val }))
                    }
                  />
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-blue-700 mb-1">
                        시작일 <span className="text-rose-500">*</span>
                      </label>
                      <DatePicker
                        value={form.startDate}
                        placeholder="시작일 선택"
                        onChange={(val) =>
                          setForm((f) => ({
                            ...f,
                            startDate: val,
                            endDate: f.endDate < val ? val : f.endDate,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-700 mb-1">
                        종료일 <span className="text-rose-500">*</span>
                      </label>
                      <DatePicker
                        value={form.endDate}
                        min={form.startDate || undefined}
                        placeholder="종료일 선택"
                        onChange={(val) => setForm((f) => ({ ...f, endDate: val }))}
                      />
                    </div>
                  </div>

                  {/* 연차 차감 미리보기 (차감 항목만) */}
                  {preview && preview.deductPerDay > 0 && (
                    <div className={`px-3 py-2 rounded-xl text-xs ${
                      preview.remainingAfter < 0
                        ? "bg-rose-50 border border-rose-200 text-rose-700"
                        : "bg-emerald-50 border border-emerald-200 text-emerald-800"
                    }`}>
                      이번 신청 <b>{fmtDays(preview.requestAmount)}일</b> 차감 · 신청 후 잔여{" "}
                      <b>{fmtDays(preview.remainingAfter)}일</b>
                      <span className="opacity-70"> (현재 잔여 {fmtDays(preview.remaining)}일)</span>
                      {preview.remainingAfter < 0 && (
                        <div className="mt-1 font-medium">⚠ 잔여를 초과합니다. 이대로는 신청할 수 없습니다.</div>
                      )}
                    </div>
                  )}

                  {/* Phase 6-2F: 시간 입력 (연차 제외 카테고리만) */}
                  {categoryAllowsTimeInput(selectedCategory?.code) && (
                    <div className="space-y-2">
                      <label className="block text-xs font-semibold text-blue-700">
                        시간 <span className="text-gray-400">(선택)</span>
                      </label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <p className="text-[11px] text-gray-500 mb-1">시작 시간</p>
                          <TimePicker
                            value={form.correctedCheckIn}
                            placeholder="HH:MM"
                            onChange={(val) =>
                              setForm((f) => ({ ...f, correctedCheckIn: val }))
                            }
                          />
                        </div>
                        <div>
                          <p className="text-[11px] text-gray-500 mb-1">종료 시간</p>
                          <TimePicker
                            value={form.correctedCheckOut}
                            placeholder="HH:MM"
                            onChange={(val) =>
                              setForm((f) => ({ ...f, correctedCheckOut: val }))
                            }
                          />
                        </div>
                      </div>

                      {/* 미리보기 */}
                      <div className="bg-blue-50 border border-blue-100 text-blue-800 px-3 py-2 rounded-lg text-xs">
                        <p className="font-semibold mb-1">📅 등록될 일정</p>
                        {!form.correctedCheckIn && !form.correctedCheckOut ? (
                          <p>
                            <span className="font-mono">{form.startDate}</span>
                            {form.startDate !== form.endDate && (
                              <>
                                {" ~ "}
                                <span className="font-mono">{form.endDate}</span>
                              </>
                            )}{" "}
                            <span className="font-medium">종일</span>
                          </p>
                        ) : (
                          <p>
                            <span className="font-mono">{form.startDate}</span>{" "}
                            <span className="font-mono font-semibold">
                              {form.correctedCheckIn || "--:--"}
                            </span>
                            {" → "}
                            <span className="font-mono">{form.endDate}</span>{" "}
                            <span className="font-mono font-semibold">
                              {form.correctedCheckOut || "--:--"}
                            </span>
                          </p>
                        )}
                      </div>

                      <p className="text-[11px] text-gray-500">
                        ⓘ 시간을 입력하지 않으면 종일 일정으로 등록됩니다.
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* 현재 기록 + 새 시각 입력 (correction 타입만) */}
              {selectedCategory?.type === "correction" && (
                <div className="space-y-3">
                  {/* 현재 기록 */}
                  <div className="bg-white border border-gray-200 rounded-xl p-3">
                    <div className="text-xs font-semibold text-gray-500 mb-2">
                      현재 기록
                    </div>
                    {dailyLoading ? (
                      <div className="flex items-center gap-2 text-sm text-gray-400">
                        <Loader2 size={14} className="animate-spin" />
                        불러오는 중...
                      </div>
                    ) : dailyFetched && !currentDaily ? (
                      <div className="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                        이 날의 출퇴근 기록이 없습니다 (무단결근 정정 신청 가능)
                      </div>
                    ) : currentDaily ? (
                      <div className="grid grid-cols-2 gap-2 text-sm font-mono">
                        <div>
                          <span className="text-gray-500">출근 </span>
                          <span className="text-gray-900 font-semibold">
                            {currentDaily.checkIn
                              ? formatDateTime(currentDaily.checkIn).split(" ")[1]
                              : "-"}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">퇴근 </span>
                          <span className="text-gray-900 font-semibold">
                            {currentDaily.checkOut
                              ? formatDateTime(currentDaily.checkOut).split(" ")[1]
                              : "-"}
                          </span>
                        </div>
                        {currentDaily.workMinutes !== null && (
                          <div className="col-span-2 text-xs text-gray-500">
                            근무: {Math.floor(currentDaily.workMinutes / 60)}시간{" "}
                            {currentDaily.workMinutes % 60}분
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>

                  {/* 새 시각 입력 */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-white border border-blue-200 rounded-xl p-3">
                    {(form.correctionType === "in_only" || form.correctionType === "both") && (
                      <div>
                        <label className="block text-xs font-semibold text-blue-700 mb-1">
                          새 출근 시각 <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="time"
                          value={form.correctedCheckIn}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, correctedCheckIn: e.target.value }))
                          }
                          className="w-full px-3 py-2 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                        />
                      </div>
                    )}
                    {(form.correctionType === "out_only" || form.correctionType === "both") && (
                      <div>
                        <label className="block text-xs font-semibold text-blue-700 mb-1">
                          새 퇴근 시각 <span className="text-rose-500">*</span>
                        </label>
                        <input
                          type="time"
                          value={form.correctedCheckOut}
                          min={form.correctedCheckIn || undefined}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, correctedCheckOut: e.target.value }))
                          }
                          className="w-full px-3 py-2 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                        />
                      </div>
                    )}
                    <div className="sm:col-span-2 text-[10px] text-blue-700">
                      선택한 시각만 결재 승인 후 적용됨. 다른 쪽은 기존 기록 유지.
                    </div>
                  </div>
                </div>
              )}

              {/* 사유 */}
              <div>
                <label className="block text-xs font-semibold text-blue-700 mb-1">
                  사유
                </label>
                <textarea
                  value={form.reason}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, reason: e.target.value }))
                  }
                  rows={2}
                  className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 resize-none"
                />
              </div>

              {/* Phase 6-2E: Google Calendar 등록 정보 (정정이 아닌 경우만) */}
              {selectedCategory?.type !== "correction" &&
                calendarSources.length > 0 && (
                  <div className="border-t border-blue-200 pt-4 mt-2">
                    <h3 className="text-sm font-bold text-blue-700 mb-3">
                      📅 Google Calendar 등록 정보 (선택)
                    </h3>
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-semibold text-blue-700 mb-1">
                          캘린더
                        </label>
                        <select
                          value={form.calendarSourceId}
                          onChange={(e) =>
                            setForm((f) => ({
                              ...f,
                              calendarSourceId: e.target.value,
                            }))
                          }
                          className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                        >
                          <option value="">— 캘린더 등록 안 함 —</option>
                          {calendarSources.map((cs) => (
                            <option key={cs.id} value={cs.id}>
                              {cs.calendarName}
                            </option>
                          ))}
                        </select>
                      </div>

                      {form.calendarSourceId && (
                        <>
                          <div>
                            <label className="block text-xs font-semibold text-blue-700 mb-1">
                              일정 제목
                            </label>
                            <input
                              type="text"
                              value={form.calendarEventTitle}
                              onChange={(e) =>
                                setForm((f) => ({
                                  ...f,
                                  calendarEventTitle: e.target.value,
                                }))
                              }
                              placeholder="[연차] HONG Gildong"
                              className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-blue-700 mb-1">
                              일정 설명
                            </label>
                            <div className="px-3 py-2 mb-2 text-xs text-blue-700/80 bg-blue-50/60 border border-blue-200 rounded-xl whitespace-pre-line select-none font-mono">
                              {memoHeader}
                            </div>
                            <textarea
                              value={extractMemoNotes(form.calendarEventDescription)}
                              onChange={(e) =>
                                setForm((f) => ({
                                  ...f,
                                  calendarEventDescription: composeMemo(
                                    memoHeader,
                                    e.target.value
                                  ),
                                }))
                              }
                              rows={4}
                              placeholder="추가로 남길 메모를 입력하세요 (선택)"
                              className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 resize-none font-mono"
                            />
                          </div>
                          <p className="text-[10px] text-blue-600/70">
                            승인 후 Google Calendar에 자동 등록됩니다. 신청 취소
                            시 캘린더에서도 함께 삭제됩니다.
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                )}

              {formError && (
                <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-xl">
                  {formError}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-5 py-2.5 bg-blue-500 text-white rounded-xl text-sm font-semibold hover:bg-blue-600 disabled:opacity-60"
                >
                  {saving
                    ? "저장 중..."
                    : editTarget
                    ? "수정 저장"
                    : "신청"}
                </button>
                <button
                  onClick={() => setShowForm(false)}
                  className="px-5 py-2.5 bg-white border border-blue-200 text-blue-700 rounded-xl text-sm font-medium hover:bg-blue-50"
                >
                  취소
                </button>
              </div>
            </div>
          )}

          {/* 필터 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-3 sm:p-4">
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              상태
            </label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full sm:w-64 px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">전체</option>
              {statusLookups.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/* 목록 */}
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 size={24} className="animate-spin text-blue-500" />
              <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
            </div>
          ) : visibleRequests.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 px-5 py-12 text-center text-sm text-gray-400 flex flex-col items-center gap-3">
              <ClipboardList size={24} className="text-gray-300" />
              신청한 결재가 없습니다. 좌상단 '결재 신청' 버튼으로 새 결재를 만드세요.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {visibleRequests.map((r) => {
                  const isPending = r.status === "pending";
                  const isRejected = r.status === "rejected";
                  const catColor = r.categoryColor;

                  return (
                    <div
                      key={r.id}
                      className="bg-white rounded-2xl border border-gray-100 p-4 sm:p-5 hover:border-blue-200 transition-colors group"
                    >
                      {/* 상단: 카테고리 + 상태 */}
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="flex items-center gap-2 min-w-0">
                          {catColor && catColor.startsWith("#") && (
                            <div
                              className="w-3 h-3 rounded-full border border-gray-200 shrink-0"
                              style={{ backgroundColor: catColor }}
                            />
                          )}
                          <h3 className="text-base font-bold text-gray-900 truncate">
                            {r.categoryName}
                          </h3>
                        </div>
                        <span
                          className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
                          style={statusBadge(r.status)}
                        >
                          {getStatusLabel(r.status)}
                        </span>
                      </div>

                      {/* 기간 */}
                      <div className="flex items-center gap-2 text-sm text-gray-700 mb-2">
                        <Calendar size={13} className="text-gray-400" />
                        <span className="font-mono">
                          {r.startDate}
                          {r.endDate !== r.startDate && ` ~ ${r.endDate}`}
                        </span>
                      </div>

                      {/* 사유 */}
                      {r.reason && (
                        <div className="flex items-start gap-2 text-sm text-gray-600 mb-2">
                          <FileText
                            size={13}
                            className="text-gray-400 mt-0.5 shrink-0"
                          />
                          <span className="line-clamp-2">{r.reason}</span>
                        </div>
                      )}

                      {/* 정정 시각 */}
                      {r.categoryType === "correction" &&
                        (r.correctedCheckIn || r.correctedCheckOut) && (
                          <div className="flex items-center gap-2 text-xs text-gray-500 mb-2 font-mono">
                            <Clock size={13} className="text-gray-400" />
                            <span>
                              정정: {formatDateTime(r.correctedCheckIn)}
                              {r.correctedCheckOut &&
                                ` ~ ${formatDateTime(r.correctedCheckOut)}`}
                            </span>
                          </div>
                        )}

                      {/* 결재자 */}
                      <div className="text-xs text-gray-500 space-y-0.5 mb-2">
                        {r.status === "auto_approved" ? (
                          <p className="text-emerald-600 font-medium">
                            <CheckCircle
                              size={11}
                              className="inline mr-1 -translate-y-px"
                            />
                            자동 승인 ·{" "}
                            {r.approvedAt &&
                              new Date(r.approvedAt).toLocaleString("ko-KR")}
                          </p>
                        ) : (
                          <>
                            {r.primaryApproverName && (
                              <p>
                                <span className="text-blue-600 font-semibold">메인</span>:{" "}
                                {r.primaryApproverName}
                              </p>
                            )}
                            {r.deputyApproverName && (
                              <p>
                                <span className="text-amber-600 font-semibold">대리</span>:{" "}
                                {r.deputyApproverName}
                              </p>
                            )}
                            {r.approvedByName && (
                              <p className="text-emerald-600">
                                <CheckCircle
                                  size={11}
                                  className="inline mr-1 -translate-y-px"
                                />
                                승인자: {r.approvedByName} ·{" "}
                                {r.approvedAt &&
                                  new Date(r.approvedAt).toLocaleString(
                                    "ko-KR"
                                  )}
                              </p>
                            )}
                          </>
                        )}
                      </div>

                      {/* 반려 사유 */}
                      {isRejected && r.rejectReason && (
                        <div className="bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 text-xs text-rose-700 flex items-start gap-2 mb-2">
                          <XCircle
                            size={13}
                            className="shrink-0 mt-0.5 text-rose-500"
                          />
                          <div>
                            <p className="font-semibold">반려 사유</p>
                            <p className="mt-0.5">{r.rejectReason}</p>
                          </div>
                        </div>
                      )}

                      {/* 등록 시각 + 작업 버튼 */}
                      <div className="flex items-center justify-between pt-2 border-t border-gray-50">
                        <p className="text-[10px] text-gray-400">
                          신청: {new Date(r.requestedAt).toLocaleString("ko-KR")}
                        </p>
                        {/* Phase 6-2E: 수정은 pending만, 취소는 pending/auto_approved/approved 허용 */}
                        {(isPending ||
                          r.status === "auto_approved" ||
                          r.status === "approved") && (
                          <div className="flex gap-1">
                            {isPending && (
                              <button
                                onClick={() => openEdit(r)}
                                className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                                title="수정"
                              >
                                <Edit size={14} />
                              </button>
                            )}
                            <button
                              onClick={() => handleCancel(r)}
                              className="p-1.5 rounded-lg hover:bg-rose-100 text-gray-400 hover:text-rose-600"
                              title={
                                isPending
                                  ? "취소"
                                  : "취소 (캘린더 일정 함께 삭제)"
                              }
                            >
                              <X size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <p className="text-xs text-gray-400 text-center pt-2">
                총 {visibleRequests.length}건
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
