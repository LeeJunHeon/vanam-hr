"use client";

import { isColumnClickable } from "@/lib/work-hours";
import WorkHoursDetail from "@/components/work-hours/WorkHoursDetail";
import {
  ExpandIcon,
  RetiredBadge,
  tone,
  type WorkHoursListProps,
} from "@/components/work-hours/shared";

// 직원별 근무시간 카드 (md 미만). 카드를 누르면 그 카드 바로 아래 일별 상세를 펼친다(한 번에 한 명).
// 카드의 주·하루 줄을 누르면 그 기간만 보기/그날 강조 — 카드 펼치기로 번지지 않게 막는다.
// 누르는 영역은 높이 40px 이상.

export default function WorkHoursMobileList({
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
  return (
    <div className="md:hidden divide-y divide-gray-100">
      {employees.map((e) => {
        const expanded = expandedId === e.id;
        const t = totalOf(e.id);
        return (
          <div key={e.id}>
            <div
              data-emp-row={e.id}
              onClick={() => onToggleEmployee(e.id)}
              className={`px-4 pt-1 pb-3 cursor-pointer ${expanded ? "bg-blue-50" : "hover:bg-slate-50"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onToggleEmployee(e.id);
                  }}
                  aria-expanded={expanded}
                  className="flex items-center gap-1.5 min-w-0 h-10 text-left"
                >
                  <ExpandIcon expanded={expanded} />
                  <span className="text-sm font-semibold text-gray-900 truncate">{e.name}</span>
                  {!e.isActive && <RetiredBadge />}
                </button>
                <span className="text-xs text-gray-400 shrink-0">{e.departmentName ?? "-"}</span>
              </div>
              <div>
                {columns.map((c) => {
                  const v = cellOf(e.id, c);
                  const isToday = view === "week" && c.days[0] === today;
                  const active = expanded && activeColumnKey === c.key;
                  const clickable = isColumnClickable(c, today);
                  const label = (
                    <>
                      <span className={`shrink-0 ${isToday ? "text-blue-600 font-semibold" : "text-gray-500"}`}>
                        {c.title} ({c.sub})
                      </span>
                      <span className={`font-mono tabular-nums truncate ${tone(v.text, v.state)}`}>{v.text}</span>
                    </>
                  );
                  const lineCls = `flex items-center justify-between gap-2 w-full min-h-10 px-2 -mx-2 text-xs rounded-lg ${
                    active ? "bg-amber-50 font-semibold" : ""
                  }`;
                  if (!clickable) {
                    // 미래 줄 "-" — 눌러도 반응하지 않는다
                    return (
                      <div
                        key={c.key}
                        onClick={(ev) => ev.stopPropagation()}
                        className={`${lineCls} box-content cursor-default`}
                      >
                        {label}
                      </div>
                    );
                  }
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onSelectColumn(e.id, c);
                      }}
                      aria-pressed={active}
                      className={`${lineCls} box-content text-left hover:bg-blue-100/60`}
                    >
                      {label}
                    </button>
                  );
                })}
                <div className="flex items-center justify-between text-xs pt-1">
                  <span className="text-gray-700 font-semibold">{totalLabel}</span>
                  <span className="text-gray-900 font-semibold font-mono tabular-nums">{t.text}</span>
                </div>
                {t.remark && <div className="text-[11px] text-orange-500 text-right">{t.remark}</div>}
              </div>
            </div>
            {expanded && detail && (
              <div data-emp-detail={e.id}>
                <WorkHoursDetail variant="cards" {...detail} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
