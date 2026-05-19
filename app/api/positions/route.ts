import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/positions?search=...&includeInactive=true
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";
    const includeInactive = searchParams.get("includeInactive") === "true";

    const where: any = {};
    if (!includeInactive) where.isActive = true;
    if (search) {
      where.OR = [
        { code: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ];
    }

    const positions = await prisma.position.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    });

    return NextResponse.json(
      positions.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        sortOrder: p.sortOrder,
        isActive: p.isActive,
      }))
    );
  } catch (error) {
    console.error("GET /api/positions error:", error);
    return NextResponse.json({ error: "직급 조회 실패" }, { status: 500 });
  }
}

// POST /api/positions — 직급 추가
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { code, name, sortOrder } = body;

    if (!code?.trim() || !name?.trim()) {
      return NextResponse.json(
        { error: "code, name은 필수입니다." },
        { status: 400 }
      );
    }

    const exists = await prisma.position.findUnique({
      where: { code: code.trim() },
    });
    if (exists) {
      return NextResponse.json(
        { error: `코드 "${code}"가 이미 존재합니다.` },
        { status: 409 }
      );
    }

    const pos = await prisma.position.create({
      data: {
        code: code.trim(),
        name: name.trim(),
        sortOrder: Number(sortOrder) || 0,
      },
    });

    return NextResponse.json(
      {
        id: pos.id,
        code: pos.code,
        name: pos.name,
        sortOrder: pos.sortOrder,
        isActive: pos.isActive,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/positions error:", error);
    return NextResponse.json({ error: "직급 등록 실패" }, { status: 500 });
  }
}

// PUT /api/positions?id=1 — 직급 수정 (code 제외)
export async function PUT(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const body = await request.json();
    const { name, sortOrder, isActive } = body;

    const before = await prisma.position.findUnique({ where: { id: idNum } });
    if (!before) {
      return NextResponse.json(
        { error: "직급을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const pos = await prisma.position.update({
      where: { id: idNum },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(sortOrder !== undefined && { sortOrder: Number(sortOrder) || 0 }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
    });

    return NextResponse.json({
      id: pos.id,
      code: pos.code,
      name: pos.name,
      sortOrder: pos.sortOrder,
      isActive: pos.isActive,
    });
  } catch (error) {
    console.error("PUT /api/positions error:", error);
    return NextResponse.json({ error: "직급 수정 실패" }, { status: 500 });
  }
}

// DELETE /api/positions?id=1
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const target = await prisma.position.findUnique({ where: { id: idNum } });
    if (!target) {
      return NextResponse.json(
        { error: "직급을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const empCount = await prisma.employee.count({
      where: { positionId: idNum },
    });
    if (empCount > 0) {
      return NextResponse.json(
        {
          error: `이 직급을 사용 중입니다 (소속 직원 ${empCount}건). 비활성 처리를 사용하세요.`,
        },
        { status: 409 }
      );
    }

    await prisma.position.delete({ where: { id: idNum } });

    return NextResponse.json({ message: "직급이 삭제되었습니다." });
  } catch (error) {
    console.error("DELETE /api/positions error:", error);
    return NextResponse.json({ error: "직급 삭제 실패" }, { status: 500 });
  }
}
