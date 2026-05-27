"use client";
import { useState, useRef, useEffect } from "react";
import { CalendarDays, X, ChevronLeft, ChevronRight } from "lucide-react";

const KO_MONTHS = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
const KO_DAYS = ["일","월","화","수","목","금","토"];

interface DatePickerProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  className?: string;
  min?: string;
  max?: string;
}

function toDisplay(s: string) {
  if (!s) return "";
  return `${s.slice(0,4)}.${s.slice(5,7)}.${s.slice(8,10)}`;
}
function toStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

export default function DatePicker({ value, onChange, placeholder = "날짜 선택", className = "", min, max }: DatePickerProps) {
  const today = new Date(); today.setHours(0,0,0,0);
  const initYear = value ? parseInt(value.slice(0,4)) : today.getFullYear();
  const initMonth = value ? parseInt(value.slice(5,7))-1 : today.getMonth();

  const [open, setOpen] = useState(false);
  const [curYear, setCurYear] = useState(initYear);
  const [curMonth, setCurMonth] = useState(initMonth);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value) { setCurYear(parseInt(value.slice(0,4))); setCurMonth(parseInt(value.slice(5,7))-1); }
  }, [value]);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const navMonth = (dir: number) => {
    let m = curMonth + dir, y = curYear;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    setCurMonth(m); setCurYear(y);
  };

  const selectDate = (date: Date) => {
    const s = toStr(date);
    if (min && s < min) return;
    if (max && s > max) return;
    onChange(s); setOpen(false);
  };

  const buildCells = () => {
    const firstDay = new Date(curYear, curMonth, 1).getDay();
    const daysInMonth = new Date(curYear, curMonth+1, 0).getDate();
    const prevLast = new Date(curYear, curMonth, 0).getDate();
    const cells: React.ReactNode[] = [];

    for (let i = 0; i < firstDay; i++)
      cells.push(<div key={`p${i}`} className="py-1 text-center text-xs text-gray-300">{prevLast - firstDay + 1 + i}</div>);

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(curYear, curMonth, d);
      const s = toStr(date);
      const isSel = value === s;
      const isToday = date.toDateString() === today.toDateString();
      const dow = (firstDay + d - 1) % 7;
      const isDisabled = (!!min && s < min) || (!!max && s > max);
      cells.push(
        <button key={d} onClick={() => selectDate(date)} disabled={isDisabled} type="button"
          className={[
            "py-1.5 text-sm rounded-lg transition-colors w-full",
            isSel ? "bg-blue-500 text-white font-semibold" :
            isToday && !isSel ? "text-blue-600 font-semibold hover:bg-blue-50" :
            dow === 0 ? "text-rose-400 hover:bg-rose-50" :
            dow === 6 ? "text-blue-400 hover:bg-blue-50" :
            "text-gray-700 hover:bg-gray-50",
            isDisabled ? "opacity-25 cursor-not-allowed" : "",
          ].filter(Boolean).join(" ")}>{d}</button>
      );
    }

    const rem = (7 - (firstDay + daysInMonth) % 7) % 7;
    for (let i = 1; i <= rem; i++)
      cells.push(<div key={`n${i}`} className="py-1 text-center text-xs text-gray-300">{i}</div>);
    return cells;
  };

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 px-3 py-2 border rounded-xl cursor-pointer bg-white text-sm transition-all select-none
          ${open ? "border-blue-500 ring-2 ring-blue-500/20" : "border-gray-200 hover:border-blue-400"}`}>
        <CalendarDays size={14} className="text-gray-400 shrink-0" />
        <span className={`flex-1 ${value ? "text-gray-900" : "text-gray-400"}`}>{toDisplay(value) || placeholder}</span>
        {value && (
          <button type="button" onClick={e => { e.stopPropagation(); onChange(""); }}
            className="text-gray-300 hover:text-gray-500 p-0.5 rounded"><X size={13} /></button>
        )}
      </div>

      {open && (
        <div className="absolute top-[calc(100%+4px)] left-0 bg-white border border-gray-200 rounded-2xl p-3 z-[200] w-64 shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={() => navMonth(-1)}
              className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-500">
              <ChevronLeft size={14} />
            </button>
            <span className="text-sm font-semibold text-gray-800">{curYear}년 {KO_MONTHS[curMonth]}</span>
            <button type="button" onClick={() => navMonth(1)}
              className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-500">
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="grid grid-cols-7 mb-1">
            {KO_DAYS.map((d, i) => (
              <div key={d} className={`text-center text-[11px] font-medium py-0.5 ${i===0?"text-rose-400":i===6?"text-blue-400":"text-gray-400"}`}>{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">{buildCells()}</div>
          <div className="mt-2 pt-2 border-t border-gray-100">
            <button type="button" onClick={() => selectDate(today)}
              className="w-full text-xs text-gray-500 hover:text-blue-500 hover:bg-blue-50 py-1.5 rounded-lg transition-colors">
              오늘
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
