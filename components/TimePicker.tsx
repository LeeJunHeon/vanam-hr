"use client";
import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  forwardRef,
  useImperativeHandle,
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
  // 넘기면: 분·빠른 선택·'확인' 클릭 시 창을 닫고 호출한다. 바깥 클릭으로 닫을 땐 부르지 않는다.
  onComplete?: () => void;
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

const TimePicker = forwardRef<TimePickerHandle, TimePickerProps>(function TimePicker(
  {
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
  },
  ref
) {
  const [open, setOpen] = useState(false);
  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (!disabled) setOpen(true);
      },
    }),
    [disabled]
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const hourScrollRef = useRef<HTMLDivElement>(null);
  const minScrollRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  // 현재 값 파싱 (24:00은 특수 처리)
  const isMidnight = value === "24:00";
  // 선택 가능 범위(분 단위). 둘 다 없으면 제한 없음 = 기존 동작.
  const lo = toMinutes(minTime);
  const hi = toMinutes(maxTime);
  const inRange = useCallback(
    (t: number) => (lo === null || t >= lo) && (hi === null || t <= hi),
    [lo, hi]
  );
  const minuteOptions = useMemo(
    () => Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep),
    [minuteStep]
  );
  // 그 시(h)에서 고를 수 있는 분 목록
  const allowedMinutes = useCallback(
    (h: number) => minuteOptions.filter((m) => inRange(h * 60 + m)),
    [minuteOptions, inRange]
  );

  // 값이 비어 있을 때 기준 시각: minTime 이 있으면 그 시(고를 수 있는 분이 있는 첫 시)의 00분, 없으면 00:00.
  const [curHour, curMin] = useMemo(() => {
    if (!value || value === "24:00") {
      if (lo === null) return [0, 0];
      const minHour = Math.min(Math.floor(lo / 60), 23);
      for (let h = minHour; h < 24; h++) {
        if (allowedMinutes(h).length > 0) return [h, 0];
      }
      return [minHour, 0];
    }
    const [h, m] = value.split(":").map(Number);
    return [isNaN(h) ? 0 : h, isNaN(m) ? 0 : m];
  }, [value, lo, allowedMinutes]);

  // onComplete 를 넘겼을 때만: 창을 닫고 부모에 선택 완료를 알린다.
  const complete = () => {
    if (!onComplete) return;
    setOpen(false);
    onComplete();
  };

  // 외부 클릭 감지 — 포털로 띄운 드롭다운 내부 클릭은 닫지 않도록 wrap/drop 둘 다 체크
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (wrapRef.current?.contains(tgt)) return;
      if (dropRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

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
    const mm = String(m).padStart(2, "0");
    const hh = String(h).padStart(2, "0");
    onChange(`${hh}:${mm}`);
  };

  const selectMin = (m: number) => {
    const hh = String(curHour).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    onChange(`${hh}:${mm}`);
    complete();
  };

  const selectMidnight = () => {
    onChange("24:00");
    setOpen(false);
    onComplete?.();
  };

  // 빠른 선택(00:00·정오) — 기존처럼 창을 닫고, onComplete 가 있으면 알린다.
  const selectQuick = (hhmm: string) => {
    onChange(hhmm);
    setOpen(false);
    onComplete?.();
  };

  const selectNow = () => {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    onChange(`${hh}:${mm}`);
    complete();
  };

  // 빠른 선택 버튼 — 결과가 범위 밖이면 비활성. (렌더마다 다시 계산되므로 '지금'은 누르는 순간 기준과 거의 같다)
  const now = new Date();
  const nowAllowed = inRange(now.getHours() * 60 + now.getMinutes());
  const quickClass = (allowed: boolean, base: string) =>
    allowed ? base : "text-gray-300 cursor-not-allowed";

  const clearValue = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange("");
  };

  // 표시 문자열
  const displayValue = value || "";
  const koreanLabel = toKoreanLabel(value);

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      {/* 입력 디스플레이 */}
      <div
        ref={triggerRef}
        onClick={() => !disabled && setOpen((o) => !o)}
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
          {value ? (
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
        {value && !disabled && (
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
          {value && (
            <div className="text-center mb-2 pb-2 border-b border-gray-100">
              <div className="text-xs text-gray-500">{koreanLabel}</div>
              <div className="text-lg font-mono font-bold text-blue-600">
                {value}
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
                onClick={selectMidnight}
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
              setOpen(false);
              onComplete?.();
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
});

export default TimePicker;

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
