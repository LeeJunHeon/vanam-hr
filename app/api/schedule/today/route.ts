import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth-helpers";
import { todayYmd } from "@/lib/dateUtils";

// GET /api/schedule/today
//
// 오늘 활성 상태인 calendar_auto 결재 요청을 조회.
// (Phase 6-2B에서 calendar-syncer가 attendance_requests로 INSERT한 행 중,
//  오늘이 start_date ~ end_date 범위에 들어가는 행만)
//
// 권한: CEO/ADMIN만 (Q6).
//
// 응답: {
//   date: "YYYY-MM-DD",
//   total: number,
//   schedules: Array<{
//     id, employeeId, employeeNo, employeeName,
//     departmentName, positionName,
//     categoryCode, categoryName, categoryColor,
//     startDate, endDate,
//     correctedCheckIn (ISO|null), correctedCheckOut (ISO|null),
//     reason, isAllDay, isMultiDay
//   }>
// }
export async function GET() {
  try {
    const r = await requireSession();
    if (!r.ok) return r.response;
    const { session } = r;

    const role = session.user.role;
    if (role !== "ceo" && role !== "admin") {
      return NextResponse.json(
        { error: "관리자 권한이 필요합니다." },
        { status: 403 }
      );
    }

    // 오늘 KST 기준 (lib/dateUtils — 컨테이너 TZ=Asia/Seoul 설정 활용)
    const todayStr = todayYmd();
    const today = new Date(todayStr);

    const requests = await prisma.attendanceRequest.findMany({
      where: {
        requestType: "calendar_auto",
        status: "auto_approved",
        externalSource: "google_calendar",
        startDate: { lte: today },
        endDate: { gte: today },
      },
      select: {
        id: true,
        employeeId: true,
        categoryId: true,
        startDate: true,
        endDate: true,
        correctedCheckIn: true,
        correctedCheckOut: true,
        reason: true,
        employee: {
          select: {
            id: true,
            employeeNo: true,
            name: true,
            department: { select: { name: true } },
            position: { select: { name: true } },
          },
        },
        category: {
          select: {
            code: true,
            name: true,
            displayColor: true,
          },
        },
      },
      orderBy: [{ employee: { name: "asc" } }],
    });

    const schedules = requests.map((r) => {
      const startYmd = r.startDate.toISOString().split("T")[0];
      const endYmd = r.endDate.toISOString().split("T")[0];
      return {
        id: r.id,
        employeeId: r.employeeId,
        employeeNo: r.employee?.employeeNo ?? "",
        employeeName: r.employee?.name ?? "",
        departmentName: r.employee?.department?.name ?? null,
        positionName: r.employee?.position?.name ?? null,
        categoryCode: r.category?.code ?? null,
        categoryName: r.category?.name ?? null,
        categoryColor: r.category?.displayColor ?? null,
        startDate: startYmd,
        endDate: endYmd,
        correctedCheckIn: r.correctedCheckIn
          ? r.correctedCheckIn.toISOString()
          : null,
        correctedCheckOut: r.correctedCheckOut
          ? r.correctedCheckOut.toISOString()
          : null,
        reason: r.reason ?? null,
        // 종일 일정: corrected_check_in/out 둘 다 NULL
        isAllDay:
          r.correctedCheckIn === null && r.correctedCheckOut === null,
        // 다일 일정 (예: 6/1~6/5 연차)
        isMultiDay: startYmd !== endYmd,
      };
    });

    // Phase 6-2L+ B-4: 오늘이 공휴일이면 이름 함께 반환 (UI 라벨용)
    const holiday = await prisma.holiday.findUnique({
      where: { holidayDate: today },
      select: { name: true },
    });

    return NextResponse.json({
      date: todayStr,
      total: schedules.length,
      schedules,
      holiday: holiday ? holiday.name : null,
    });
  } catch (error) {
    console.error("GET /api/schedule/today error:", error);
    return NextResponse.json(
      { error: "일정 조회 실패" },
      { status: 500 }
    );
  }
}
