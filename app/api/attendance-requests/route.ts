import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getTargetEmployeeId,
  requireSession,
  isAdminSession,
} from "@/lib/auth-helpers";

function parseDate(s: string | null | undefined): Date | null {
  if (!s || typeof s !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

function ymdFromDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// category.type → requestType 매핑
function categoryTypeToRequestType(categoryType: string): string {
  if (categoryType === "correction") return "correction";
  if (categoryType === "work") return "external_work";
  // leave, long_leave, 기타
  return "leave";
}

// GET /api/attendance-requests?employeeId=N&status=...&from=...&to=...
// 비관리자: 본인 요청만, 관리자: 다른 직원도 조회 가능.
export async function GET(request: NextRequest) {
  try {
    const r = await getTargetEmployeeId(request);
    if (!r.ok) return r.response;
    const employeeId = r.employeeId;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "";
    const fromRaw = searchParams.get("from");
    const toRaw = searchParams.get("to");

    const where: any = { employeeId };
    if (status) where.status = status;
    if (fromRaw || toRaw) {
      where.startDate = {};
      if (fromRaw) {
        const f = parseDate(fromRaw);
        if (f) where.startDate.gte = f;
      }
      if (toRaw) {
        const t = parseDate(toRaw);
        if (t) {
          const next = new Date(t);
          next.setUTCDate(next.getUTCDate() + 1);
          where.startDate.lt = next;
        }
      }
    }

    const requests = await prisma.attendanceRequest.findMany({
      where,
      orderBy: [{ requestedAt: "desc" }],
      include: {
        category: {
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            displayColor: true,
            requireApproval: true,
          },
        },
        primaryApprover: {
          select: { id: true, employeeNo: true, name: true },
        },
        deputyApprover: {
          select: { id: true, employeeNo: true, name: true },
        },
        approvedBy: { select: { id: true, employeeNo: true, name: true } },
      },
    });

    return NextResponse.json(
      requests.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        categoryId: r.categoryId,
        categoryCode: r.category.code,
        categoryName: r.category.name,
        categoryType: r.category.type,
        categoryColor: r.category.displayColor,
        requestType: r.requestType,
        startDate: ymdFromDate(r.startDate),
        endDate: ymdFromDate(r.endDate),
        reason: r.reason,
        correctedCheckIn: r.correctedCheckIn
          ? r.correctedCheckIn.toISOString()
          : null,
        correctedCheckOut: r.correctedCheckOut
          ? r.correctedCheckOut.toISOString()
          : null,
        status: r.status,
        primaryApproverId: r.primaryApproverId,
        primaryApproverName: r.primaryApprover?.name ?? null,
        deputyApproverId: r.deputyApproverId,
        deputyApproverName: r.deputyApprover?.name ?? null,
        approvedById: r.approvedById,
        approvedByName: r.approvedBy?.name ?? null,
        approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
        rejectReason: r.rejectReason,
        requestedAt: r.requestedAt.toISOString(),
      }))
    );
  } catch (error) {
    console.error("GET /api/attendance-requests error:", error);
    return NextResponse.json(
      { error: "결재 요청 조회 실패" },
      { status: 500 }
    );
  }
}

// POST /api/attendance-requests — 본인 신청
// body.employeeId는 비관리자의 경우 본인 employeeId여야 함.
export async function POST(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const ownId = session.user.employeeId;
    const isAdmin = isAdminSession(session);

    const body = await request.json();
    const {
      employeeId,
      categoryId,
      startDate,
      endDate,
      reason,
      correctedCheckIn,
      correctedCheckOut,
    } = body;

    if (!employeeId || !categoryId || !startDate || !endDate) {
      return NextResponse.json(
        { error: "employeeId, categoryId, startDate, endDate는 필수입니다." },
        { status: 400 }
      );
    }

    const employeeIdNum = Number(employeeId);
    const categoryIdNum = Number(categoryId);

    if (!Number.isInteger(employeeIdNum) || !Number.isInteger(categoryIdNum)) {
      return NextResponse.json(
        { error: "employeeId, categoryId는 정수여야 합니다." },
        { status: 400 }
      );
    }

    // 비관리자는 본인만 신청 가능
    if (!isAdmin) {
      if (!Number.isInteger(ownId)) {
        return NextResponse.json(
          {
            error:
              "본인 직원 정보가 매핑되어 있지 않습니다. 관리자에게 직원 등록을 요청하세요.",
          },
          { status: 403 }
        );
      }
      if (employeeIdNum !== ownId) {
        return NextResponse.json(
          { error: "본인 명의로만 신청할 수 있습니다." },
          { status: 403 }
        );
      }
    }

    const startD = parseDate(startDate);
    const endD = parseDate(endDate);
    if (!startD || !endD) {
      return NextResponse.json(
        { error: "startDate, endDate 형식이 잘못되었습니다 (YYYY-MM-DD)." },
        { status: 400 }
      );
    }
    if (endD < startD) {
      return NextResponse.json(
        { error: "종료일은 시작일 이후여야 합니다." },
        { status: 400 }
      );
    }

    // 직원 활성 검증
    const emp = await prisma.employee.findUnique({
      where: { id: employeeIdNum },
    });
    if (!emp || !emp.isActive) {
      return NextResponse.json(
        { error: "활성 직원이 아닙니다." },
        { status: 400 }
      );
    }

    // 카테고리 활성 검증
    const category = await prisma.attendanceCategory.findUnique({
      where: { id: categoryIdNum },
    });
    if (!category || !category.isActive) {
      return NextResponse.json(
        { error: "활성 근태 항목이 아닙니다." },
        { status: 400 }
      );
    }

    const reqType = categoryTypeToRequestType(category.type);

    // correction 타입은 정정 시각 필수
    let cciDate: Date | null = null;
    let ccoDate: Date | null = null;
    if (reqType === "correction") {
      if (!correctedCheckIn || !correctedCheckOut) {
        return NextResponse.json(
          { error: "근태정정은 정정 출근/퇴근 시각이 모두 필요합니다." },
          { status: 400 }
        );
      }
      cciDate = new Date(correctedCheckIn);
      ccoDate = new Date(correctedCheckOut);
      if (isNaN(cciDate.getTime()) || isNaN(ccoDate.getTime())) {
        return NextResponse.json(
          { error: "정정 시각 형식이 잘못되었습니다." },
          { status: 400 }
        );
      }
      if (ccoDate <= cciDate) {
        return NextResponse.json(
          { error: "정정 퇴근 시각은 정정 출근 시각 이후여야 합니다." },
          { status: 400 }
        );
      }
    }

    // 결재선 lookup
    let primaryApproverId: number | null = null;
    let deputyApproverId: number | null = null;
    if (emp.departmentId !== null) {
      const line = await prisma.approvalLine.findUnique({
        where: { departmentId: emp.departmentId },
      });
      if (line) {
        primaryApproverId = line.primaryApproverId;
        deputyApproverId = line.deputyApproverId;
      }
    }

    // requireApproval=true인데 결재선 없으면 차단
    if (category.requireApproval && primaryApproverId === null) {
      return NextResponse.json(
        {
          error:
            "본인 부서에 결재선이 설정되어 있지 않아 신청할 수 없습니다. 관리자에게 결재선 등록을 요청하세요.",
        },
        { status: 400 }
      );
    }

    const isAutoApproved = !category.requireApproval;
    const now = new Date();

    const created = await prisma.attendanceRequest.create({
      data: {
        employeeId: employeeIdNum,
        categoryId: categoryIdNum,
        requestType: reqType,
        startDate: startD,
        endDate: endD,
        reason: reason?.trim() || null,
        correctedCheckIn: cciDate,
        correctedCheckOut: ccoDate,
        status: isAutoApproved ? "auto_approved" : "pending",
        primaryApproverId,
        deputyApproverId,
        approvedAt: isAutoApproved ? now : null,
      },
    });

    return NextResponse.json(
      { id: created.id, status: created.status },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/attendance-requests error:", error);
    return NextResponse.json(
      { error: "결재 요청 등록 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/attendance-requests?id=N
// 두 흐름: action="cancel" 취소 / 그 외 필드 수정 (둘 다 pending 만 가능)
// 비관리자: 본인 요청만 수정/취소 가능.
export async function PUT(request: NextRequest) {
  try {
    const sessionR = await requireSession();
    if (!sessionR.ok) return sessionR.response;
    const { session } = sessionR;
    const ownId = session.user.employeeId;
    const isAdmin = isAdminSession(session);

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const body = await request.json();
    const {
      action, // "cancel" | undefined
      categoryId,
      startDate,
      endDate,
      reason,
      correctedCheckIn,
      correctedCheckOut,
    } = body;

    const before = await prisma.attendanceRequest.findUnique({
      where: { id: idNum },
    });
    if (!before) {
      return NextResponse.json(
        { error: "요청을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // 본인 검증 (관리자 우회 허용)
    if (!isAdmin) {
      if (!Number.isInteger(ownId) || before.employeeId !== ownId) {
        return NextResponse.json(
          { error: "본인의 요청만 수정/취소할 수 있습니다." },
          { status: 403 }
        );
      }
    }

    if (before.status !== "pending") {
      return NextResponse.json(
        { error: "결재 대기 상태가 아니므로 수정/취소할 수 없습니다." },
        { status: 409 }
      );
    }

    // 취소 흐름
    if (action === "cancel") {
      const updated = await prisma.attendanceRequest.update({
        where: { id: idNum },
        data: { status: "cancelled" },
      });
      return NextResponse.json({ id: updated.id, status: updated.status });
    }

    // 수정 흐름
    const data: any = {};
    if (categoryId !== undefined) {
      const cid = Number(categoryId);
      if (!Number.isInteger(cid)) {
        return NextResponse.json(
          { error: "categoryId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      const cat = await prisma.attendanceCategory.findUnique({
        where: { id: cid },
      });
      if (!cat || !cat.isActive) {
        return NextResponse.json(
          { error: "활성 근태 항목이 아닙니다." },
          { status: 400 }
        );
      }
      data.categoryId = cid;
      data.requestType = categoryTypeToRequestType(cat.type);
    }
    if (startDate !== undefined) {
      const d = parseDate(startDate);
      if (!d)
        return NextResponse.json(
          { error: "startDate 형식 오류" },
          { status: 400 }
        );
      data.startDate = d;
    }
    if (endDate !== undefined) {
      const d = parseDate(endDate);
      if (!d)
        return NextResponse.json(
          { error: "endDate 형식 오류" },
          { status: 400 }
        );
      data.endDate = d;
    }
    // 시작/종료일 일관성 (최종값 기준)
    const finalStart = data.startDate ?? before.startDate;
    const finalEnd = data.endDate ?? before.endDate;
    if (finalEnd < finalStart) {
      return NextResponse.json(
        { error: "종료일은 시작일 이후여야 합니다." },
        { status: 400 }
      );
    }
    if (reason !== undefined) data.reason = reason?.trim() || null;
    if (correctedCheckIn !== undefined) {
      data.correctedCheckIn = correctedCheckIn
        ? new Date(correctedCheckIn)
        : null;
    }
    if (correctedCheckOut !== undefined) {
      data.correctedCheckOut = correctedCheckOut
        ? new Date(correctedCheckOut)
        : null;
    }

    const updated = await prisma.attendanceRequest.update({
      where: { id: idNum },
      data,
    });
    return NextResponse.json({ id: updated.id, status: updated.status });
  } catch (error) {
    console.error("PUT /api/attendance-requests error:", error);
    return NextResponse.json(
      { error: "결재 요청 수정 실패" },
      { status: 500 }
    );
  }
}
