import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// 자동 위임 시간 계산
function isDelegationElapsed(requestedAt: Date, hours: number): boolean {
  const elapsed = Date.now() - requestedAt.getTime();
  return elapsed >= hours * 60 * 60 * 1000;
}

function hoursUntilDelegation(requestedAt: Date, hours: number): number {
  const elapsed = Date.now() - requestedAt.getTime();
  const total = hours * 60 * 60 * 1000;
  return Math.max(0, (total - elapsed) / (1000 * 60 * 60));
}

// GET /api/approvals?approverId=N&status=pending|approved|rejected|all
// pending: 본인이 메인/대리인 대기 요청
// approved/rejected: 본인이 처리한 해당 상태 요청
// 그 외 (또는 status 미전달): 본인이 처리한 전체 이력 (approved + rejected)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const approverIdRaw = searchParams.get("approverId");
    const status = searchParams.get("status") || "pending";

    if (!approverIdRaw) {
      return NextResponse.json(
        { error: "approverId 파라미터가 필요합니다." },
        { status: 400 }
      );
    }
    const approverId = Number(approverIdRaw);
    if (!Number.isInteger(approverId)) {
      return NextResponse.json(
        { error: "approverId는 정수여야 합니다." },
        { status: 400 }
      );
    }

    let where: any = {};
    if (status === "pending") {
      where = {
        status: "pending",
        OR: [
          { primaryApproverId: approverId },
          { deputyApproverId: approverId },
        ],
      };
    } else if (status === "approved" || status === "rejected") {
      where = { status, approvedById: approverId };
    } else {
      // 본인이 결재한 전체 이력
      where = {
        approvedById: approverId,
        status: { in: ["approved", "rejected"] },
      };
    }

    const requests = await prisma.attendanceRequest.findMany({
      where,
      orderBy: [{ requestedAt: "desc" }],
      include: {
        employee: {
          select: {
            id: true,
            employeeNo: true,
            name: true,
            departmentId: true,
            department: {
              select: {
                id: true,
                name: true,
                approvalLine: {
                  select: { autoDelegateHours: true },
                },
              },
            },
          },
        },
        category: {
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            displayColor: true,
          },
        },
        primaryApprover: { select: { id: true, name: true } },
        deputyApprover: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json(
      requests.map((r) => {
        const isPrimary = r.primaryApproverId === approverId;
        const isDeputy = r.deputyApproverId === approverId;
        const autoDelegateHours =
          r.employee.department?.approvalLine?.autoDelegateHours ?? 24;
        const delegated = isDelegationElapsed(r.requestedAt, autoDelegateHours);
        const hoursLeft = hoursUntilDelegation(r.requestedAt, autoDelegateHours);

        let canApprove = false;
        let myRole: "primary" | "deputy" | null = null;
        if (isPrimary) {
          canApprove = true;
          myRole = "primary";
        } else if (isDeputy) {
          canApprove = delegated;
          myRole = "deputy";
        }

        // 본인이 신청자면 차단
        if (r.employeeId === approverId) {
          canApprove = false;
        }

        return {
          id: r.id,
          employeeId: r.employeeId,
          employeeNo: r.employee.employeeNo,
          employeeName: r.employee.name,
          departmentName: r.employee.department?.name ?? null,
          categoryId: r.categoryId,
          categoryCode: r.category.code,
          categoryName: r.category.name,
          categoryType: r.category.type,
          categoryColor: r.category.displayColor,
          requestType: r.requestType,
          startDate: r.startDate.toISOString().split("T")[0],
          endDate: r.endDate.toISOString().split("T")[0],
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
          approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
          rejectReason: r.rejectReason,
          requestedAt: r.requestedAt.toISOString(),
          myRole,
          autoDelegateHours,
          delegated,
          hoursLeft,
          canApprove,
          isSelfRequest: r.employeeId === approverId,
        };
      })
    );
  } catch (error) {
    console.error("GET /api/approvals error:", error);
    return NextResponse.json(
      { error: "결재 목록 조회 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/approvals?id=N — 승인/반려
// body: { approverId, action: 'approve' | 'reject', rejectReason? }
export async function PUT(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const body = await request.json();
    const { approverId, action, rejectReason } = body;

    if (!approverId || !action) {
      return NextResponse.json(
        { error: "approverId, action은 필수입니다." },
        { status: 400 }
      );
    }
    if (action !== "approve" && action !== "reject") {
      return NextResponse.json(
        { error: "action은 'approve' 또는 'reject'여야 합니다." },
        { status: 400 }
      );
    }
    if (action === "reject" && !rejectReason?.trim()) {
      return NextResponse.json(
        { error: "반려는 사유가 필수입니다." },
        { status: 400 }
      );
    }

    const approverIdNum = Number(approverId);
    if (!Number.isInteger(approverIdNum)) {
      return NextResponse.json(
        { error: "approverId는 정수여야 합니다." },
        { status: 400 }
      );
    }

    const target = await prisma.attendanceRequest.findUnique({
      where: { id: idNum },
      include: {
        employee: {
          select: {
            departmentId: true,
            department: {
              select: {
                approvalLine: { select: { autoDelegateHours: true } },
              },
            },
          },
        },
      },
    });
    if (!target) {
      return NextResponse.json(
        { error: "요청을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    if (target.status !== "pending") {
      return NextResponse.json(
        { error: "결재 대기 상태가 아닙니다." },
        { status: 409 }
      );
    }

    // 본인이 자기 신청을 결재하는 케이스 차단
    if (target.employeeId === approverIdNum) {
      return NextResponse.json(
        { error: "본인의 신청은 결재할 수 없습니다." },
        { status: 403 }
      );
    }

    const isPrimary = target.primaryApproverId === approverIdNum;
    const isDeputy = target.deputyApproverId === approverIdNum;
    if (!isPrimary && !isDeputy) {
      return NextResponse.json(
        { error: "이 요청의 결재자가 아닙니다." },
        { status: 403 }
      );
    }

    // 대리인 경우 자동 위임 시간 경과 검증
    if (!isPrimary && isDeputy) {
      const hours =
        target.employee.department?.approvalLine?.autoDelegateHours ?? 24;
      const elapsed = Date.now() - target.requestedAt.getTime();
      if (elapsed < hours * 60 * 60 * 1000) {
        return NextResponse.json(
          {
            error:
              "메인 결재자 응답 대기 중입니다. 자동 위임까지 시간이 남아 있어 대리 결재가 불가합니다.",
          },
          { status: 403 }
        );
      }
    }

    const newStatus = action === "approve" ? "approved" : "rejected";
    const now = new Date();

    const updated = await prisma.attendanceRequest.update({
      where: { id: idNum },
      data: {
        status: newStatus,
        approvedById: approverIdNum,
        approvedAt: now,
        rejectReason: action === "reject" ? rejectReason.trim() : null,
      },
    });

    return NextResponse.json({ id: updated.id, status: updated.status });
  } catch (error) {
    console.error("PUT /api/approvals error:", error);
    return NextResponse.json({ error: "결재 처리 실패" }, { status: 500 });
  }
}
