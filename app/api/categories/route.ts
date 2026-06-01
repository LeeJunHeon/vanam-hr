import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// GET /api/categories?type=...&search=...&includeInactive=true
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || "";
    const search = searchParams.get("search") || "";
    const includeInactive = searchParams.get("includeInactive") === "true";

    const where: any = {};
    if (type) where.type = type;
    if (!includeInactive) where.isActive = true;
    if (search) {
      where.OR = [
        { code: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ];
    }

    const categories = await prisma.attendanceCategory.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    });

    return NextResponse.json(
      categories.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        type: c.type,
        annualLeaveDeduct: c.annualLeaveDeduct ? Number(c.annualLeaveDeduct) : null,
        requireApproval: c.requireApproval,
        displayColor: c.displayColor,
        isSystem: c.isSystem,
        isActive: c.isActive,
        sortOrder: c.sortOrder,
        description: c.description,
      }))
    );
  } catch (error) {
    console.error("GET /api/categories error:", error);
    return NextResponse.json(
      { error: "근태 항목 조회 실패" },
      { status: 500 }
    );
  }
}

// POST /api/categories — 근태 항목 추가
export async function POST(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const body = await request.json();
    const {
      code,
      name,
      type,
      annualLeaveDeduct,
      requireApproval,
      displayColor,
      sortOrder,
      description,
    } = body;

    if (!code?.trim() || !name?.trim() || !type?.trim()) {
      return NextResponse.json(
        { error: "code, name, type은 필수입니다." },
        { status: 400 }
      );
    }

    const exists = await prisma.attendanceCategory.findUnique({
      where: { code: code.trim() },
    });
    if (exists) {
      return NextResponse.json(
        { error: `코드 "${code}" 가 이미 존재합니다.` },
        { status: 409 }
      );
    }

    // type 값이 code_lookups의 category_type 카테고리에 존재하는지 검증
    const typeLookup = await prisma.codeLookup.findUnique({
      where: {
        category_code: {
          category: "category_type",
          code: type.trim(),
        },
      },
    });
    if (!typeLookup || !typeLookup.isActive) {
      return NextResponse.json(
        {
          error: `유형 "${type}"이 유효하지 않습니다. 코드 룩업의 category_type에서 활성 코드를 사용하세요.`,
        },
        { status: 400 }
      );
    }

    const category = await prisma.attendanceCategory.create({
      data: {
        code: code.trim(),
        name: name.trim(),
        type: type.trim(),
        annualLeaveDeduct:
          annualLeaveDeduct === null || annualLeaveDeduct === undefined || annualLeaveDeduct === ""
            ? null
            : Number(annualLeaveDeduct),
        requireApproval: requireApproval !== false, // 기본 true
        displayColor: displayColor?.trim() || null,
        sortOrder: Number(sortOrder) || 0,
        description: description?.trim() || null,
        isSystem: false, // 사용자가 추가하는 건 항상 비시스템
      },
    });

    return NextResponse.json(
      {
        id: category.id,
        code: category.code,
        name: category.name,
        type: category.type,
        annualLeaveDeduct: category.annualLeaveDeduct ? Number(category.annualLeaveDeduct) : null,
        requireApproval: category.requireApproval,
        displayColor: category.displayColor,
        isSystem: category.isSystem,
        isActive: category.isActive,
        sortOrder: category.sortOrder,
        description: category.description,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/categories error:", error);
    return NextResponse.json(
      { error: "근태 항목 등록 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/categories?id=1 — 근태 항목 수정
export async function PUT(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }

    const body = await request.json();
    const {
      name,
      type,
      annualLeaveDeduct,
      requireApproval,
      displayColor,
      sortOrder,
      isActive,
      description,
    } = body;

    const before = await prisma.attendanceCategory.findUnique({
      where: { id: Number(id) },
    });
    if (!before) {
      return NextResponse.json(
        { error: "항목을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // 시스템 항목은 code 변경 차단 (이미 PUT body에 code 안 받음).
    // type 변경 시에도 lookup 검증
    if (type !== undefined && type !== before.type) {
      const typeLookup = await prisma.codeLookup.findUnique({
        where: {
          category_code: {
            category: "category_type",
            code: type.trim(),
          },
        },
      });
      if (!typeLookup || !typeLookup.isActive) {
        return NextResponse.json(
          {
            error: `유형 "${type}"이 유효하지 않습니다. 코드 룩업의 category_type에서 활성 코드를 사용하세요.`,
          },
          { status: 400 }
        );
      }
    }

    const category = await prisma.attendanceCategory.update({
      where: { id: Number(id) },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(type !== undefined && !before.isSystem && { type: type.trim() }), // 시스템 항목은 type 잠금
        ...(annualLeaveDeduct !== undefined && {
          annualLeaveDeduct:
            annualLeaveDeduct === null || annualLeaveDeduct === ""
              ? null
              : Number(annualLeaveDeduct),
        }),
        ...(requireApproval !== undefined && {
          requireApproval: Boolean(requireApproval),
        }),
        ...(displayColor !== undefined && {
          displayColor: displayColor?.trim() || null,
        }),
        ...(sortOrder !== undefined && { sortOrder: Number(sortOrder) || 0 }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
        ...(description !== undefined && {
          description: description?.trim() || null,
        }),
      },
    });

    return NextResponse.json({
      id: category.id,
      code: category.code,
      name: category.name,
      type: category.type,
      annualLeaveDeduct: category.annualLeaveDeduct ? Number(category.annualLeaveDeduct) : null,
      requireApproval: category.requireApproval,
      displayColor: category.displayColor,
      isSystem: category.isSystem,
      isActive: category.isActive,
      sortOrder: category.sortOrder,
      description: category.description,
    });
  } catch (error) {
    console.error("PUT /api/categories error:", error);
    return NextResponse.json(
      { error: "근태 항목 수정 실패" },
      { status: 500 }
    );
  }
}

// DELETE /api/categories?id=1 — 근태 항목 삭제
export async function DELETE(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }

    const target = await prisma.attendanceCategory.findUnique({
      where: { id: Number(id) },
    });
    if (!target) {
      return NextResponse.json(
        { error: "항목을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    if (target.isSystem) {
      return NextResponse.json(
        { error: "시스템 항목은 삭제할 수 없습니다. 비활성 처리를 사용하세요." },
        { status: 409 }
      );
    }

    // 참조 무결성 — attendance_daily / attendance_requests에 사용 중인지 확인
    // (calendar_color_mappings는 Phase 6-2A에서 테이블 자체가 삭제됨)
    const [dailyCount, requestCount] = await Promise.all([
      prisma.attendanceDaily.count({ where: { categoryId: Number(id) } }),
      prisma.attendanceRequest.count({ where: { categoryId: Number(id) } }),
    ]);

    if (dailyCount > 0 || requestCount > 0) {
      const refs: string[] = [];
      if (dailyCount > 0) refs.push(`일별 근태 ${dailyCount}건`);
      if (requestCount > 0) refs.push(`결재 요청 ${requestCount}건`);
      return NextResponse.json(
        {
          error: `이 항목을 사용 중입니다 (${refs.join(", ")}). 비활성 처리를 사용하세요.`,
        },
        { status: 409 }
      );
    }

    await prisma.attendanceCategory.delete({ where: { id: Number(id) } });

    return NextResponse.json({ message: "근태 항목이 삭제되었습니다." });
  } catch (error) {
    console.error("DELETE /api/categories error:", error);
    return NextResponse.json(
      { error: "근태 항목 삭제 실패" },
      { status: 500 }
    );
  }
}
