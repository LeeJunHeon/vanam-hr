import ExcelJS from "exceljs";
import type { AttendanceRow } from "@/lib/attendance-rows";
import { AUTO_STATUS_META } from "@/lib/attendanceLabels";
import { settledProgressLabel } from "@/lib/attendanceProgress";

// 근태 전용 워크북 (서버 전용, prisma import 금지 — 순수 함수).
// 레이아웃: 세로=출근/퇴근/평가/사유, 가로=날짜, 월 블록을 과거→현재로 아래로 stack.

export interface WorkbookEmployee {
  id: number;
  employeeNo: string | null;
  name: string;
  departmentName: string | null;
  positionName: string | null;
}

const KST = "Asia/Seoul";

// 서버 컨테이너 TZ가 UTC일 수 있으므로 attendanceLabels.formatTime(로컬 기준) 대신
// 이 파일 안에서 KST 강제 변환을 직접 구현한다.
function hhmmKst(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: KST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso)); // "09:02"
}

// "YYYY-MM-DD" → 요일 인덱스 (0=일 ... 6=토). 서버 TZ 무관하게 UTC 기준으로 안전.
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
function dowOf(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// 시트명 정제: Excel 금지문자 제거, 31자 절단, 중복 시 접미.
function sanitizeSheetName(name: string, used: Set<string>): string {
  let base = (name || "").replace(/[\\/?*[\]:]/g, "").trim();
  if (!base) base = "직원";
  base = base.slice(0, 31);
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = `(${n})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    n++;
  }
  used.add(candidate);
  return candidate;
}

// 평가 셀 판정 (§4-C 규칙 순서대로).
function evalCell(row: AttendanceRow, todayYmd: string): string {
  // 1) 캘린더 보정(카테고리) 우선
  if (row.isOverridden && row.categoryName) {
    const auto = row.autoStatus;
    if (auto === "late" || auto === "early_leave" || auto === "absent") {
      return `${row.categoryName} (${AUTO_STATUS_META[auto].label})`;
    }
    return row.categoryName;
  }
  // 2) autoStatus 4종
  if (row.autoStatus && row.autoStatus in AUTO_STATUS_META) {
    return AUTO_STATUS_META[row.autoStatus as keyof typeof AUTO_STATUS_META]
      .label;
  }
  // 3) autoStatus 도입 전 옛 데이터 보호
  if (row.checkIn && row.checkOut) return "정상";
  // 4) 진행 라벨
  return settledProgressLabel({
    hasCheckIn: !!row.checkIn,
    hasCheckOut: !!row.checkOut,
    isToday: row.workDate === todayYmd,
  });
}

// 사유 셀 = 첫 번째 비어있지 않은 값.
function reasonCell(row: AttendanceRow): string {
  return row.statusReason || row.reason || row.note || "";
}

// startDate~endDate 가 걸치는 달 목록 (과거→현재 오름차순). ["YYYY-MM", ...]
function monthsInRange(startDate: string, endDate: string): string[] {
  const [sy, sm] = startDate.split("-").map(Number);
  const [ey, em] = endDate.split("-").map(Number);
  const out: string[] = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad2(m)}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

const FILL_MONTH_HEADER = "FFE5E7EB"; // 월 헤더 배경
const FILL_LABEL = "FFF9FAFB"; // A열 라벨 배경
const FILL_WEEKEND = "FFF3F4F6"; // 토/일 열 배경
const FILL_HOLIDAY = "FFFEE2E2"; // 공휴일 열 배경

function solid(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

export function buildAttendanceWorkbook(p: {
  employees: WorkbookEmployee[];
  rows: AttendanceRow[];
  holidays: { date: string; name: string }[];
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // "YYYY-MM-DD"
  todayYmd: string; // KST 오늘 "YYYY-MM-DD"
}): ExcelJS.Workbook {
  const { employees, rows, holidays, startDate, endDate, todayYmd } = p;

  // (employeeId, workDate) → row 로 O(1) 인덱싱
  const rowMap = new Map<string, AttendanceRow>();
  for (const r of rows) rowMap.set(`${r.employeeId}_${r.workDate}`, r);

  const holidayMap = new Map<string, string>();
  for (const h of holidays) holidayMap.set(h.date, h.name);

  const months = monthsInRange(startDate, endDate);

  const wb = new ExcelJS.Workbook();
  const usedNames = new Set<string>();

  // 직원이 없어도 최소 1개 시트가 있어야 유효한 xlsx
  if (employees.length === 0) {
    wb.addWorksheet("근태");
  }

  for (const emp of employees) {
    const ws = wb.addWorksheet(sanitizeSheetName(emp.name, usedNames));

    // 제목 행 (A1 = 이름 bold 14)
    const nameCell = ws.getCell(1, 1);
    nameCell.value = emp.name;
    nameCell.font = { bold: true, size: 14 };

    // A2 = "부서 · 직급 · 사번 N" (없는 값 생략)
    const subParts: string[] = [];
    if (emp.departmentName) subParts.push(emp.departmentName);
    if (emp.positionName) subParts.push(emp.positionName);
    if (emp.employeeNo) subParts.push(`사번 ${emp.employeeNo}`);
    if (subParts.length > 0) {
      const subCell = ws.getCell(2, 1);
      subCell.value = subParts.join(" · ");
      subCell.font = { size: 11, color: { argb: "FF6B7280" } };
    }

    let r = 4; // A3 은 빈 행, 블록은 4행부터 시작

    for (const ym of months) {
      const [yy, mm] = ym.split("-").map(Number);
      const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();

      const headerRowIdx = r;
      const inRowIdx = r + 1;
      const outRowIdx = r + 2;
      const evalRowIdx = r + 3;
      const reasonRowIdx = r + 4;

      // A열 라벨
      ws.getCell(headerRowIdx, 1).value = ym;
      ws.getCell(inRowIdx, 1).value = "출근";
      ws.getCell(outRowIdx, 1).value = "퇴근";
      ws.getCell(evalRowIdx, 1).value = "평가";
      ws.getCell(reasonRowIdx, 1).value = "사유";

      // 월 헤더 A셀 스타일
      const monthLabelCell = ws.getCell(headerRowIdx, 1);
      monthLabelCell.font = { bold: true };
      monthLabelCell.fill = solid(FILL_MONTH_HEADER);
      monthLabelCell.border = {
        bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
      };
      monthLabelCell.alignment = { horizontal: "center", vertical: "middle" };

      // A열 라벨(출근/퇴근/평가) 스타일
      for (const idx of [inRowIdx, outRowIdx, evalRowIdx]) {
        const c = ws.getCell(idx, 1);
        c.font = { bold: true };
        c.fill = solid(FILL_LABEL);
        c.alignment = { horizontal: "center", vertical: "middle" };
      }
      // '사유' 라벨은 좌측 정렬 계열이지만 라벨 자체는 통일 위해 라벨 스타일 유지
      {
        const c = ws.getCell(reasonRowIdx, 1);
        c.font = { bold: true };
        c.fill = solid(FILL_LABEL);
        c.alignment = { horizontal: "center", vertical: "middle" };
      }

      // 날짜 열
      for (let d = 1; d <= daysInMonth; d++) {
        const col = d + 1; // B열부터
        const ymd = `${ym}-${pad2(d)}`;
        const dow = dowOf(ymd);
        const isWeekend = dow === 0 || dow === 6;
        const holidayName = holidayMap.get(ymd) ?? null;

        // 헤더 셀 = "1(목)"
        const hCell = ws.getCell(headerRowIdx, col);
        hCell.value = `${d}(${WEEKDAYS[dow]})`;
        hCell.font = { bold: true };
        hCell.border = {
          bottom: { style: "thin", color: { argb: "FFD1D5DB" } },
        };
        hCell.alignment = { horizontal: "center", vertical: "middle" };
        if (holidayName) {
          hCell.fill = solid(FILL_HOLIDAY);
          hCell.note = holidayName;
        } else if (isWeekend) {
          hCell.fill = solid(FILL_WEEKEND);
        } else {
          hCell.fill = solid(FILL_MONTH_HEADER);
        }

        const row = rowMap.get(`${emp.id}_${ymd}`);

        // 출근
        const inCell = ws.getCell(inRowIdx, col);
        // 퇴근
        const outCell = ws.getCell(outRowIdx, col);
        // 평가
        const evCell = ws.getCell(evalRowIdx, col);
        // 사유
        const rsCell = ws.getCell(reasonRowIdx, col);

        if (row) {
          const inV = hhmmKst(row.checkIn);
          if (inV) {
            inCell.value = row.originalCheckIn ? `${inV}*` : inV;
            if (row.originalCheckIn) {
              inCell.note = `원본 ${hhmmKst(row.originalCheckIn)}`;
            }
          }
          const outV = hhmmKst(row.checkOut);
          if (outV) {
            outCell.value = row.originalCheckOut ? `${outV}*` : outV;
            if (row.originalCheckOut) {
              outCell.note = `원본 ${hhmmKst(row.originalCheckOut)}`;
            }
          }
          evCell.value = evalCell(row, todayYmd);
          rsCell.value = reasonCell(row);
        }

        // 정렬: 기본 center, 사유만 left + wrap
        inCell.alignment = { horizontal: "center", vertical: "middle" };
        outCell.alignment = { horizontal: "center", vertical: "middle" };
        evCell.alignment = { horizontal: "center", vertical: "middle" };
        rsCell.alignment = {
          horizontal: "left",
          vertical: "middle",
          wrapText: true,
        };

        // 토/일·공휴일 열 배경 (4개 데이터 행)
        const bg = holidayName
          ? FILL_HOLIDAY
          : isWeekend
            ? FILL_WEEKEND
            : null;
        if (bg) {
          inCell.fill = solid(bg);
          outCell.fill = solid(bg);
          evCell.fill = solid(bg);
          rsCell.fill = solid(bg);
        }
      }

      r += 6; // 4개 데이터 행 + 헤더 + 빈 행
    }

    // 열 너비: A=14, 날짜 열=9
    ws.getColumn(1).width = 14;
    const maxCols = 1 + 31;
    for (let c = 2; c <= maxCols; c++) {
      ws.getColumn(c).width = 9;
    }

    // A열 고정
    ws.views = [{ state: "frozen", xSplit: 1 }];
  }

  return wb;
}
