"use client";

import { Fragment } from "react";
import { isColumnClickable } from "@/lib/work-hours";
import WorkHoursDetail from "@/components/work-hours/WorkHoursDetail";
import {
  ExpandIcon,
  RetiredBadge,
  ZERO,
  numCls,
  tdCls,
  thBase,
  tone,
  weekdayTone,
  type WorkHoursListProps,
} from "@/components/work-hours/shared";

// 직원별 근무시간 표 (md 이상). 열 너비 고정(table-fixed) — 달마다 주 개수가 달라도 이름·부서·합계·비고 위치는 그대로,
// 좁은 창에서는 카드 안에서만 가로 스크롤(이름 칸 고정).
// 행을 누르면 그 행 바로 아래 <tr><td colSpan> 에 일별 상세를 펼친다(한 번에 한 명).
// 주·하루 칸을 누르면 그 기간만 보기/그날 강조 — 행 클릭으로 번지지 않게 막는다.
// 상세 영역은 sticky left-0 + 100cqw(표 스크롤 상자 폭) — 표를 가로로 밀어도 상세는 보이는 폭에 맞게 남는다.

export default function WorkHoursTable({
  view,
  columns,
  employees,
  today,
  totalLabel,
  cellOf,
  totalOf,
  expandedId,
  activeColumnKey,
  onToggleEmployee,
  onSelectColumn,
  detail,
}: WorkHoursListProps) {
  const thCls = `h-[52px] px-3 ${thBase}`;
  const thNumCls = `h-[52px] px-2 text-right ${thBase}`;
  const colCount = columns.length + 4;

  return (
    <div className="hidden md:block overflow-x-auto @container">
      <table className="w-full min-w-[1280px] table-fixed">
        <colgroup>
          <col className="w-[180px]" />
          <col className="w-[110px]" />
          {columns.map((c) => (
            <col key={c.key} />
          ))}
          <col className="w-[140px]" />
          <col className="w-[170px]" />
        </colgroup>
        <thead>
          <tr className="bg-gray-50 border-b border-gray-100">
            <th className={`${thCls} text-left sticky left-0 z-10 bg-gray-50`}>이름</th>
            <th className={`${thCls} text-left`}>부서</th>
            {columns.map((c) => {
              const isToday = view === "week" && c.days[0] === today;
              return (
                <th key={c.key} className={`${thNumCls} ${isToday ? "bg-blue-50" : ""}`}>
                  <div className={view === "week" ? weekdayTone(c.key) : ""}>{c.title}</div>
                  <div className="text-[11px] font-normal text-gray-400 font-mono tabular-nums">{c.sub}</div>
                </th>
              );
            })}
            <th className={thNumCls}>{totalLabel}</th>
            <th className={`${thCls} text-left`}>비고</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((e) => {
            const expanded = expandedId === e.id;
            const t = totalOf(e.id);
            return (
              <Fragment key={e.id}>
                <tr
                  data-emp-row={e.id}
                  onClick={() => onToggleEmployee(e.id)}
                  className={`group cursor-pointer border-b border-gray-50 ${
                    expanded ? "bg-blue-50" : "hover:bg-slate-50"
                  }`}
                >
                  <td
                    className={`${tdCls} sticky left-0 z-[1] ${
                      expanded ? "bg-blue-50" : "bg-white group-hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onToggleEmployee(e.id);
                        }}
                        aria-expanded={expanded}
                        className="flex items-center gap-1.5 min-w-0 font-semibold text-gray-900 hover:text-blue-600"
                        title={e.name}
                      >
                        <ExpandIcon expanded={expanded} />
                        <span className="truncate">{e.name}</span>
                      </button>
                      {!e.isActive && <RetiredBadge />}
                    </div>
                  </td>
                  <td className={`${tdCls} text-gray-600`} title={e.departmentName ?? undefined}>
                    {e.departmentName ?? "-"}
                  </td>
                  {columns.map((c) => {
                    const v = cellOf(e.id, c);
                    const isToday = view === "week" && c.days[0] === today;
                    const active = expanded && activeColumnKey === c.key;
                    const bg = active ? "bg-amber-50" : isToday ? "bg-blue-50/60" : "";
                    if (!isColumnClickable(c, today)) {
                      // 미래 칸 "-" — 눌러도 반응하지 않는다(행 펼치기로도 번지지 않음)
                      return (
                        <td
                          key={c.key}
                          onClick={(ev) => ev.stopPropagation()}
                          className={`${numCls} cursor-default ${tone(v.text, v.state)} ${bg}`}
                        >
                          {v.text}
                        </td>
                      );
                    }
                    return (
                      <td key={c.key} className={`h-11 p-0 ${bg}`}>
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            onSelectColumn(e.id, c);
                          }}
                          aria-pressed={active}
                          className={`${numCls} block w-full hover:bg-blue-100/60 ${active ? "font-semibold" : ""} ${tone(v.text, v.state)}`}
                          title={view === "month" ? `${c.title} (${c.sub}) 일별 보기` : v.text}
                        >
                          {v.text}
                        </button>
                      </td>
                    );
                  })}
                  <td
                    className={`${numCls} font-semibold ${t.text === "-" || t.text === ZERO ? "text-gray-300" : "text-gray-900"}`}
                  >
                    {t.text}
                  </td>
                  <td className={`${tdCls} text-xs text-orange-500`} title={t.remark || undefined}>
                    {t.remark}
                  </td>
                </tr>
                {expanded && detail && (
                  <tr data-emp-detail={e.id} className="border-b border-gray-100">
                    <td colSpan={colCount} className="p-0">
                      <div className="sticky left-0 w-[100cqw]">
                        <WorkHoursDetail variant="table" {...detail} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
