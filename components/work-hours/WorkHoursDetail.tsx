"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { renderTimeCell } from "@/components/AttendanceTimeCell";
import { PROGRESS_WORKING } from "@/lib/attendanceLabels";
import {
  dayMinutesText,
  periodMinutesText,
  periodRemarkText,
  rangeMdText,
  weekLabel,
  weekdayKo,
  type DayState,
  type DetailLine,
  type MonthWeek,
  type PeriodTotal,
  type WorkHoursDayRow,
} from "@/lib/work-hours";
import {
  RetiredBadge,
  ZERO,
  numCls,
  tdCls,
  thBase,
  weekdayTone,
  type WorkHoursEmployee,
} from "@/components/work-hours/shared";

// 직원 일별 상세 — 직원 표(누른 행 바로 아래 <td colSpan>)와 휴대폰 카드(카드 바로 아래)가 같이 쓴다.
// 날짜 줄·주 소계·합계는 부모(WorkHoursPage)가 lib/work-hours buildDetailLines 로 한 번 만들어 넘긴다.
// 펼친 영역 모양은 AnnualLeavePage 펼치기와 같다(border-t bg-gray-50/50 안에 흰 rounded-lg).

export interface WorkHoursDetailData {
  employee: WorkHoursEmployee;
  periodLabel: string;
  /** 월별 보기에서 주 칸을 눌러 그 주만 볼 때 */
  focusWeek: MonthWeek | null;
  /** 주별 보기에서 하루 칸을 눌러 강조한 날 */
  focusDay: string | null;
  lines: DetailLine[];
  total: PeriodTotal;
  today: string;
  getRow: (ymd: string) => WorkHoursDayRow | null;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  /** "월 전체 보기" */
  onShowMonth: () => void;
}

interface Props extends WorkHoursDetailData {
  variant: "table" | "cards";
}

function minutesTone(minutes: string, state: DayState, base: string): string {
  if (minutes === "-" || minutes === ZERO) return "text-gray-300";
  return state === "working" ? PROGRESS_WORKING.cls : base;
}

// 날짜 줄 배경 — 강조한 날(연한 노랑) > 오늘(연한 파랑)
function dayBg(ymd: string, today: string, focusDay: string | null): string {
  if (ymd === focusDay) return "bg-amber-50";
  if (ymd === today) return "bg-blue-50/60";
  return "";
}

export default function WorkHoursDetail(props: Props) {
  const { variant, total } = props;
  const totalText = periodMinutesText(total);
  const remark = periodRemarkText(total);
  return (
    <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50 space-y-2.5">
      <DetailHeader {...props} />
      {variant === "table" ? (
        <DetailTable {...props} totalText={totalText} remark={remark} />
      ) : (
        <DetailCards {...props} totalText={totalText} remark={remark} />
      )}
    </div>
  );
}

// ───── 머리줄: 이름 · 부서 · 기간 [3주 (10/12~10/18) · 월 전체 보기]   ‹ 이전 직원 | 다음 직원 › X ─────
function DetailHeader({
  employee,
  periodLabel,
  focusWeek,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  onShowMonth,
}: Props) {
  const navBtn =
    "inline-flex items-center gap-0.5 h-10 md:h-8 px-2 text-xs font-medium rounded-lg text-gray-600 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-default";
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
        <span className="text-sm font-bold text-gray-900 truncate">{employee.name}</span>
        {!employee.isActive && <RetiredBadge />}
        <span className="text-xs text-gray-400 whitespace-nowrap">
          {[employee.departmentName, periodLabel].filter(Boolean).join(" · ")}
        </span>
        {focusWeek && (
          <span className="flex items-center gap-1">
            <span className="text-xs font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full whitespace-nowrap font-mono tabular-nums">
              {weekLabel(focusWeek)}
            </span>
            <button
              type="button"
              onClick={onShowMonth}
              className="h-10 md:h-8 px-2 text-xs text-blue-600 hover:text-blue-700 rounded-lg hover:bg-blue-50 whitespace-nowrap"
            >
              월 전체 보기
            </button>
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 ml-auto shrink-0">
        <button type="button" onClick={onPrev} disabled={!hasPrev} className={navBtn}>
          <ChevronLeft size={14} />
          이전 직원
        </button>
        <span className="text-gray-200 select-none" aria-hidden>
          |
        </span>
        <button type="button" onClick={onNext} disabled={!hasNext} className={navBtn}>
          다음 직원
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center h-10 w-10 md:h-8 md:w-8 rounded-lg hover:bg-gray-100"
          aria-label="접기"
        >
          <X size={16} className="text-gray-400" />
        </button>
      </div>
    </div>
  );
}

interface BodyProps extends Props {
  totalText: string;
  remark: string;
}

// ───── 데스크톱: 날짜 | 출근 | 퇴근 | 근무 | 사유 ─────
function DetailTable({ lines, today, focusDay, getRow, totalText, remark }: BodyProps) {
  const thCls = `h-10 px-3 ${thBase}`;
  return (
    <div className="bg-white rounded-lg border border-gray-100 overflow-x-auto">
      <table className="w-full min-w-[720px] table-fixed">
        <colgroup>
          <col className="w-[120px]" />
          <col className="w-[150px]" />
          <col className="w-[150px]" />
          <col className="w-[130px]" />
          <col />
        </colgroup>
        <thead>
          <tr className="bg-gray-50 border-b border-gray-100">
            <th className={`${thCls} text-left`}>날짜</th>
            <th className={`${thCls} text-left`}>출근</th>
            <th className={`${thCls} text-left`}>퇴근</th>
            <th className={`h-10 px-2 text-right ${thBase}`}>근무</th>
            <th className={`${thCls} text-left`}>사유</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            if (line.kind === "subtotal") {
              const text = periodMinutesText(line.total);
              const r = periodRemarkText(line.total);
              return (
                <tr key={`w${line.week.index}`} className="bg-gray-50 border-b border-gray-100">
                  <td colSpan={3} className={`${tdCls} text-xs font-semibold text-gray-600 font-mono tabular-nums`}>
                    {line.week.index}주 소계 ({rangeMdText(line.week.start, line.week.end)})
                  </td>
                  <td className={`${numCls} font-semibold ${text === "-" || text === ZERO ? "text-gray-300" : "text-gray-900"}`}>
                    {text}
                  </td>
                  <td className={`${tdCls} text-xs text-orange-500`} title={r || undefined}>
                    {r}
                  </td>
                </tr>
              );
            }
            const { ymd, summary } = line;
            const row = getRow(ymd);
            const future = summary.state === "future";
            const minutes = dayMinutesText(summary);
            const notes = summary.notes.join(", ");
            const bg = dayBg(ymd, today, focusDay);
            return (
              <tr key={ymd} className={`border-b border-gray-50 last:border-0 ${bg || "hover:bg-slate-50"}`}>
                <td className={`${tdCls} font-mono tabular-nums ${future ? "text-gray-300" : "text-gray-700"}`}>
                  {ymd.slice(5)} (<span className={future ? "" : weekdayTone(ymd)}>{weekdayKo(ymd)}</span>)
                </td>
                <td className={`${tdCls} font-mono tabular-nums ${row?.checkIn && !future ? "text-gray-900" : "text-gray-300"}`}>
                  {row && !future ? renderTimeCell(row.originalCheckIn, row.checkIn) : "-"}
                </td>
                <td className={`${tdCls} font-mono tabular-nums ${row?.checkOut && !future ? "text-gray-900" : "text-gray-300"}`}>
                  {row && !future ? renderTimeCell(row.originalCheckOut, row.checkOut, row.workDate) : "-"}
                </td>
                <td className={`${numCls} ${minutesTone(minutes, summary.state, "text-gray-900")}`}>{minutes}</td>
                <td className={`${tdCls} ${notes ? "text-gray-600" : "text-gray-300"}`} title={notes || undefined}>
                  {notes || "-"}
                </td>
              </tr>
            );
          })}
          <tr className="bg-gray-50 border-t border-gray-100">
            <td colSpan={3} className={`${tdCls} font-semibold text-gray-700`}>
              합계
            </td>
            <td className={`${numCls} font-semibold text-gray-900`}>{totalText}</td>
            <td className={`${tdCls} text-xs text-orange-500`} title={remark || undefined}>
              {remark}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ───── 휴대폰: 날짜·근무 / 출근 ~ 퇴근·사유 ─────
function DetailCards({ lines, today, focusDay, getRow, totalText, remark }: BodyProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-100 overflow-hidden divide-y divide-gray-50">
      {lines.map((line) => {
        if (line.kind === "subtotal") {
          const text = periodMinutesText(line.total);
          const r = periodRemarkText(line.total);
          return (
            <div key={`w${line.week.index}`} className="px-3 py-2 bg-gray-50 space-y-0.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-gray-600 font-mono tabular-nums">
                  {line.week.index}주 소계 ({rangeMdText(line.week.start, line.week.end)})
                </span>
                <span className={`font-semibold font-mono tabular-nums ${text === "-" || text === ZERO ? "text-gray-300" : "text-gray-900"}`}>
                  {text}
                </span>
              </div>
              {r && <div className="text-[11px] text-orange-500 text-right">{r}</div>}
            </div>
          );
        }
        const { ymd, summary } = line;
        const row = getRow(ymd);
        const future = summary.state === "future";
        const minutes = dayMinutesText(summary);
        return (
          <div key={ymd} className={`px-3 py-2.5 space-y-1 ${dayBg(ymd, today, focusDay)}`}>
            <div className="flex items-center justify-between">
              <span className={`text-sm font-semibold font-mono ${future ? "text-gray-300" : "text-gray-900"}`}>
                {ymd.slice(5)} (<span className={future ? "" : weekdayTone(ymd)}>{weekdayKo(ymd)}</span>)
              </span>
              <span className={`text-xs font-mono tabular-nums font-semibold ${minutesTone(minutes, summary.state, "text-gray-700")}`}>
                {minutes}
              </span>
            </div>
            {!future && (row || summary.notes.length > 0) && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-900 font-mono">
                  {row ? (
                    <>
                      {renderTimeCell(row.originalCheckIn, row.checkIn)} ~{" "}
                      {renderTimeCell(row.originalCheckOut, row.checkOut, row.workDate)}
                    </>
                  ) : (
                    "-"
                  )}
                </span>
                {summary.notes.length > 0 && (
                  <span className="text-gray-600 truncate ml-2">{summary.notes.join(", ")}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="px-3 py-2.5 space-y-0.5 bg-gray-50">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold text-gray-700">합계</span>
          <span className="font-semibold text-gray-900 font-mono tabular-nums">{totalText}</span>
        </div>
        {remark && <div className="text-[11px] text-orange-500 text-right">{remark}</div>}
      </div>
    </div>
  );
}
