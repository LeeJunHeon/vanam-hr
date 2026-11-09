"use client";
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { Clock, X } from "lucide-react";

interface TimePickerProps {
  value: string;                  // "HH:MM" 형식, "24:00" 가상 지원
  onChange: (val: string) => void; // "HH:MM" 반환, "24:00" 그대로 (저장 시 23:59 변환은 부모가)
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  allowMidnight?: boolean;         // true면 "24:00" 빠른 선택 버튼 노출 (시프트 종료용)
  minuteStep?: number;             // 분 휠 간격(기본 5). 1이면 1분 단위
  // ── 아래는 모두 선택 옵션. 안 넘기면 기존 동작 그대로(범위 제한 없음, 분을 눌러도 창이 열린 채) ──
  minTime?: string;                // "HH:MM" 이상만 선택 가능(포함)
  maxTime?: string;                // "HH:MM" 이하만 선택 가능(포함)
  // 넘기면 "선택 완료 모드":
  //  - 창이 열려 있는 동안 시·분 클릭은 내부 임시값(draft)만 바꾸고, 확정할 때 onChange 로 한 번 반영한다.
  //  - 분·빠른 선택·'확인' 클릭 = 반영 → 창 닫기 → onComplete 호출.
  //  - 바깥 클릭으로 닫히면 반영만 하고 onComplete 는 부르지 않는다.
  // 안 넘기면 시·분 클릭마다 바로 onChange.
  onComplete?: () => void;
  // 부모가 창을 열 때 쓰는 핸들. (forwardRef 로 감싸면 린트가 이 컴포넌트를 분석하지 못해 prop 으로 받는다)
  ref?: Ref<TimePickerHandle>;
}

// 부모가 ref 로 창을 열 때 쓰는 핸들 (disabled 이면 열리지 않는다)
export interface TimePickerHandle {
  open: () => void;
}

// "HH:MM" → 분(0~1439, "24:00" 은 1440). 비었거나 형식이 틀리면 null.
function toMinutes(hhmm: string | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// "HH:MM" 에 분을 더하거나 뺀다(delta 음수 가능). 결과는 00:00~23:59 로 자른다.
// 형식이 틀리면 받은 값을 그대로 돌려준다.
export function addMinutesHhmm(hhmm: string, delta: number): string {
  const base = toMinutes(hhmm);
  if (base === null) return hhmm;
  const t = Math.min(Math.max(base + delta, 0), 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// 지금 시각(분). 렌더 중이 아니라 클릭·열기 같은 이벤트에서만 부른다.
function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function fromMinutes(t: number): string {
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// "HH:MM" → 한글 보조 라벨
function toKoreanLabel(hhmm: string): string {
  if (!hhmm) return "";
  if (hhmm === "24:00") return "자정 (밤 12시)";
  if (hhmm === "23:59") return "자정 직전";
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return "";
  if (h === 0 && m === 0) return "자정 (밤 12시)";
  if (h === 12 && m === 0) return "정오 (낮 12시)";
  if (h < 12) {
    return `오전 ${h}시${m > 0 ? ` ${m}분` : ""}`;
  } else if (h === 12) {
    return `오후 12시${m > 0 ? ` ${m}분` : ""}`;
  } else {
    const ampm = h >= 18 ? "저녁" : "오후";
    return `${ampm} ${h - 12}시${m > 0 ? ` ${m}분` : ""}`;
  }
}

export default function TimePicker({
  value,
  onChange,
  disabled = false,
  placeholder = "시간 선택",
  className = "",
  allowMidnight = false,
  minuteStep = 5,
  minTime,
  maxTime,
  onComplete,
  ref,
}: TimePickerProps) {
  const [open, setOpen] = useState(false);
  // 선택 완료 모드(onComplete 를 넘긴 경우)에서만 쓰는 임시값. null = 창을 연 뒤 아직 바꾸지 않음(= 현재 value).
  const deferred = !!onComplete;
  const [draft, setDraft] = useState<string | null>(null);
  // 창을 연 시점의 '지금'(분). '지금' 버튼 비활성 판단에 쓴다. 누르는 순간에도 다시 확인한다.
  const [nowAtOpen, setNowAtOpen] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hourScrollRef = useRef<HTMLDivElement>(null);
  const minScrollRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  // 창을 연다 — draft 는 현재 value 에서 시작(null)
  const openWindow = () => {
    if (disabled) return;
    setDraft(null);
    setNowAtOpen(nowMinutes());
    setOpen(true);
  };
  useImperativeHandle(ref, () => ({ open: openWindow }));

  // 화면에 보여 줄 값: 선택 완료 모드에서 창이 열려 있으면 draft, 아니면 value
  const shown = deferred && open && draft !== null ? draft : value;

  // 현재 값 파싱 (24:00은 특수 처리)
  const isMidnight = shown === "24:00";
  // 선택 가능 범위(분 단위). 둘 다 없으면 제한 없음 = 기존 동작.
  const lo = toMinutes(minTime);
  const hi = toMinutes(maxTime);
  const inRange = (t: number) => (lo === null || t >= lo) && (hi === null || t <= hi);
  const minuteOptions = Array.from(
    { length: Math.ceil(60 / minuteStep) },
    (_, i) => i * minuteStep
  );
  // 그 시(h)에서 고를 수 있는 분 목록
  const allowedMinutes = (h: number) => minuteOptions.filter((m) => inRange(h * 60 + m));

  // 값이 비어 있을 때 기준 시각: minTime 이 있으면 그 시(고를 수 있는 분이 있는 첫 시)의 00분, 없으면 00:00.
  let curHour = 0;
  let curMin = 0;
  if (!shown || shown === "24:00") {
    if (lo !== null) {
      const minHour = Math.min(Math.floor(lo / 60), 23);
      curHour = minHour;
      for (let h = minHour; h < 24; h++) {
        if (allowedMinutes(h).length > 0) {
          curHour = h;
          break;
        }
      }
    }
  } else {
    const [h, m] = shown.split(":").map(Number);
    curHour = isNaN(h) ? 0 : h;
    curMin = isNaN(m) ? 0 : m;
  }

  // 창을 닫는다. 선택 완료 모드에서 draft 가 value 와 다르면 먼저 반영한다.
  const closeWindow = () => {
    if (deferred && draft !== null && draft !== value) onChange(draft);
    setDraft(null);
    setOpen(false);
  };
  // 시·분 클릭: 선택 완료 모드면 draft 만, 아니면 바로 반영
  const setVal = (v: string) => {
    if (deferred) setDraft(v);
    else onChange(v);
  };
  // 선택 완료 모드에서 값 확정: 반영 → 닫기 → 부모에 알림
  const commitAndComplete = (v: string) => {
    if (v !== value) onChange(v);
    setDraft(null);
    setOpen(false);
    onComplete?.();
  };

  // 외부 클릭 감지 — 포털로 띄운 드롭다운 내부 클릭은 닫지 않도록 wrap/drop 둘 다 체크
  // 선택 완료 모드에서는 닫으면서 draft 를 반영한다(onComplete 는 부르지 않는다).
  // 최신 draft·value 를 보도록 렌더마다 다시 건다(열려 있을 때만).
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (wrapRef.current?.contains(tgt)) return;
      if (dropRef.current?.contains(tgt)) return;
      closeWindow();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  });

  // 드롭다운 위치 계산 — fixed portal이라 trigger의 viewport 좌표를 기준으로
  // 잡고, 페이지/모달 스크롤·리사이즈 때마다 재계산. 페인트 후 실측 높이로
  // 한 번 더 재계산해 위로 열릴지 결정.
  const DROP_W = 256; // w-64
  const recompute = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const dropH = dropRef.current?.offsetHeight ?? 320;
    const m = 8;
    const openUp =
      window.innerHeight - r.bottom < dropH + m && r.top > dropH + m;
    const left = Math.min(Math.max(m, r.left), window.innerWidth - DROP_W - m);
    const top = openUp ? r.top - dropH - 4 : r.bottom + 4;
    setCoords({ top, left });
  }, []);
  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    recompute();
    const raf = requestAnimationFrame(recompute);
    const onWin = () => recompute();
    window.addEventListener("scroll", onWin, true); // capture: 모달 내부 스크롤까지
    window.addEventListener("resize", onWin);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onWin, true);
      window.removeEventListener("resize", onWin);
    };
  }, [open, recompute]);

  // 열릴 때 현재 값으로 스크롤 위치 이동
  useEffect(() => {
    if (!open) return;
    setTimeout(() => {
      if (hourScrollRef.current && !isMidnight) {
        const itemHeight = 32;
        hourScrollRef.current.scrollTop = curHour * itemHeight;
      }
      if (minScrollRef.current && !isMidnight) {
        const itemHeight = 32;
        // minuteStep 단위로 표시하므로 인덱스 계산
        minScrollRef.current.scrollTop = Math.floor(curMin / minuteStep) * itemHeight;
      }
    }, 50);
  }, [open, curHour, curMin, isMidnight, minuteStep]);

  const selectHour = (h: number) => {
    // "그 시:현재 분" 이 범위 밖이면 그 시 안에서 가장 가까운 허용 분으로 맞춘다
    // (min 쪽이면 가장 작은 허용 분, max 쪽이면 가장 큰 허용 분). 범위가 없으면 항상 그대로.
    let m = curMin;
    if (!inRange(h * 60 + m)) {
      const allowed = allowedMinutes(h);
      if (allowed.length === 0) return;
      m = lo !== null && h * 60 + m < lo ? allowed[0] : allowed[allowed.length - 1];
    }
    setVal(fromMinutes(h * 60 + m));
  };

  const selectMin = (m: number) => {
    const v = fromMinutes(curHour * 60 + m);
    if (deferred) commitAndComplete(v);
    else onChange(v); // 기존 동작: 창은 열린 채
  };

  // 빠른 선택(00:00·정오·자정) — 반영하고 창을 닫는다. onComplete 가 있으면 알린다.
  const selectQuick = (hhmm: string) => {
    onChange(hhmm);
    setDraft(null);
    setOpen(false);
    onComplete?.();
  };

  const selectNow = () => {
    // 누르는 순간 기준으로 범위를 다시 확인한다(창을 연 뒤 시간이 흘렀을 수 있다)
    const t = nowMinutes();
    if (!inRange(t)) {
      setNowAtOpen(t);
      return;
    }
    const v = fromMinutes(t);
    if (deferred) {
      onChange(v);
      setDraft(null);
      setOpen(false);
      onComplete?.();
    } else {
      onChange(v); // 기존 동작: 창은 열린 채
    }
  };

  // 빠른 선택 버튼 — 결과가 범위 밖이면 비활성. '지금'은 창을 연 시점 기준.
  const nowAllowed = nowAtOpen === null || inRange(nowAtOpen);
  const quickClass = (allowed: boolean, base: string) =>
    allowed ? base : "text-gray-300 cursor-not-allowed";

  const clearValue = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(null);
    onChange("");
  };

  // 표시 문자열
  const displayValue = shown || "";
  const koreanLabel = toKoreanLabel(shown);

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      {/* 입력 디스플레이 */}
      <div
        ref={triggerRef}
        onClick={() => {
          if (disabled) return;
          if (open) closeWindow();
          else openWindow();
        }}
        className={`flex items-center gap-2 px-3 py-2 border rounded-xl bg-white text-sm transition-all select-none ${
          disabled
            ? "cursor-not-allowed opacity-50 bg-gray-50"
            : "cursor-pointer"
        } ${
          open
            ? "border-blue-500 ring-2 ring-blue-500/20"
            : "border-gray-200 hover:border-blue-400"
        }`}
      >
        <Clock size={14} className="text-gray-400 shrink-0" />
        <div className="flex-1 min-w-0">
          {shown ? (
            <div className="flex items-baseline gap-2">
              <span className="text-gray-900 font-mono font-semibold">
                {displayValue}
              </span>
              <span className="text-[10px] text-gray-400 truncate">
                {koreanLabel}
              </span>
            </div>
          ) : (
            <span className="text-gray-400">{placeholder}</span>
          )}
        </div>
        {shown && !disabled && (
          <button
            type="button"
            onClick={clearValue}
            className="text-gray-300 hover:text-gray-500 p-0.5 rounded"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* 드롭다운 — portal로 body에 띄워 모달 overflow/transform 클리핑 회피 */}
      {open && !disabled && typeof document !== "undefined" &&
        createPortal(
        <div
          ref={dropRef}
          style={{
            position: "fixed",
            top: coords?.top ?? 0,
            left: coords?.left ?? 0,
            visibility: coords ? "visible" : "hidden",
          }}
          className="bg-white border border-gray-200 rounded-2xl p-3 z-[1000] w-64 shadow-xl"
        >
          {/* 한글 라벨 (선택값 표시) */}
          {shown && (
            <div className="text-center mb-2 pb-2 border-b border-gray-100">
              <div className="text-xs text-gray-500">{koreanLabel}</div>
              <div className="text-lg font-mono font-bold text-blue-600">
                {shown}
              </div>
            </div>
          )}

          {/* 시/분 휠 (24:00일 땐 숨김) */}
          {!isMidnight && (
            <div className="grid grid-cols-2 gap-2 mb-2">
              {/* 시 */}
              <div>
                <div className="text-[10px] text-gray-400 text-center mb-1">시</div>
                <div
                  ref={hourScrollRef}
                  className="h-40 overflow-y-auto border border-gray-100 rounded-lg"
                  style={{ scrollSnapType: "y mandatory" }}
                >
                  {Array.from({ length: 24 }, (_, i) => {
                    // 그 시에 고를 수 있는 분이 하나도 없으면 회색·클릭 불가
                    const enabled = allowedMinutes(i).length > 0;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => selectHour(i)}
                        disabled={!enabled}
                        style={{ scrollSnapAlign: "center" }}
                        className={`w-full h-8 text-sm font-mono transition-colors ${
                          !enabled
                            ? "text-gray-300 cursor-not-allowed"
                            : i === curHour
                            ? "bg-blue-500 text-white font-bold"
                            : "text-gray-700 hover:bg-blue-50"
                        }`}
                      >
                        {String(i).padStart(2, "0")}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 분 (minuteStep 단위, 기본 5) */}
              <div>
                <div className="text-[10px] text-gray-400 text-center mb-1">분</div>
                <div
                  ref={minScrollRef}
                  className="h-40 overflow-y-auto border border-gray-100 rounded-lg"
                  style={{ scrollSnapType: "y mandatory" }}
                >
                  {minuteOptions.map((m) => {
                    // 범위 밖 분은 회색·클릭 불가
                    const enabled = inRange(curHour * 60 + m);
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => selectMin(m)}
                        disabled={!enabled}
                        style={{ scrollSnapAlign: "center" }}
                        className={`w-full h-8 text-sm font-mono transition-colors ${
                          !enabled
                            ? "text-gray-300 cursor-not-allowed"
                            : m === curMin
                            ? "bg-blue-500 text-white font-bold"
                            : "text-gray-700 hover:bg-blue-50"
                        }`}
                      >
                        {String(m).padStart(2, "0")}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* 24:00 선택 시 안내 */}
          {isMidnight && (
            <div className="mb-2 px-3 py-4 bg-purple-50 rounded-lg text-center">
              <div className="text-2xl font-mono font-bold text-purple-700">
                24:00
              </div>
              <div className="text-xs text-purple-600 mt-1">
                자정 (밤 12시)
              </div>
              <div className="text-[10px] text-gray-500 mt-2">
                실제 저장값: 23:59
              </div>
            </div>
          )}

          {/* 빠른 선택 */}
          <div className="flex gap-1 pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={selectNow}
              disabled={!nowAllowed}
              className={`flex-1 text-[10px] py-1.5 rounded-lg ${quickClass(
                nowAllowed,
                "text-gray-500 hover:text-blue-500 hover:bg-blue-50"
              )}`}
            >
              지금
            </button>
            <button
              type="button"
              onClick={() => selectQuick("00:00")}
              disabled={!inRange(0)}
              className={`flex-1 text-[10px] py-1.5 rounded-lg ${quickClass(
                inRange(0),
                "text-gray-500 hover:text-blue-500 hover:bg-blue-50"
              )}`}
            >
              00:00
            </button>
            <button
              type="button"
              onClick={() => selectQuick("12:00")}
              disabled={!inRange(12 * 60)}
              className={`flex-1 text-[10px] py-1.5 rounded-lg ${quickClass(
                inRange(12 * 60),
                "text-gray-500 hover:text-blue-500 hover:bg-blue-50"
              )}`}
            >
              정오
            </button>
            {allowMidnight && (
              <button
                type="button"
                onClick={() => selectQuick("24:00")}
                disabled={!inRange(24 * 60)}
                className={`flex-1 text-[10px] py-1.5 rounded-lg font-semibold ${quickClass(
                  inRange(24 * 60),
                  "text-purple-600 hover:text-purple-700 hover:bg-purple-50"
                )}`}
              >
                자정
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              if (deferred) commitAndComplete(draft ?? value);
              else setOpen(false);
            }}
            className="mt-2 w-full text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 py-1.5 rounded-lg"
          >
            확인
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

// 외부에서 사용할 헬퍼: "24:00" → "23:59" 변환 (DB 저장 시)
export function normalizeTimeForDb(time: string): string {
  return time === "24:00" ? "23:59" : time;
}

// 외부에서 사용할 헬퍼: "23:59" → "24:00" 복원 (DB 로드 시, end 시간만)
// 시작 시간엔 사용하지 말 것 (실제 23:59 시작은 그대로 둠)
export function denormalizeTimeForDisplay(time: string): string {
  return time === "23:59" ? "24:00" : time;
}

// 총 근무시간 계산 (분 단위)
export function calcWorkMinutes(start: string, end: string): number | null {
  if (!start || !end) return null;
  const endNorm = end === "24:00" ? "24:00" : end;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = endNorm === "24:00" ? [24, 0] : endNorm.split(":").map(Number);
  if (isNaN(sh) || isNaN(sm) || isNaN(eh) || isNaN(em)) return null;
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60; // 자정 넘김 (예: 22:00 ~ 06:00)
  return mins;
}

// 분 → "X시간 Y분" 포맷
export function formatWorkDuration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "-";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}
