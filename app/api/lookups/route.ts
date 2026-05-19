import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/lookups?category=...&search=...&includeInactive=true
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category") || "";
    const search = searchParams.get("search") || "";
    const includeInactive = searchParams.get("includeInactive") === "true";

    const where: any = {};
    if (category) where.category = category;
    if (!includeInactive) where.isActive = true;
    if (search) {
      where.OR = [
        { code: { contains: search, mode: "insensitive" } },
        { label: { contains: search, mode: "insensitive" } },
      ];
    }

    const lookups = await prisma.codeLookup.findMany({
      where,
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { code: "asc" }],
    });

    return NextResponse.json(
      lookups.map((l) => ({
        id: l.id,
        category: l.category,
        code: l.code,
        label: l.label,
        color: l.color,
        sortOrder: l.sortOrder,
        isSystem: l.isSystem,
        isActive: l.isActive,
        description: l.description,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      }))
    );
  } catch (error) {
    console.error("GET /api/lookups error:", error);
    return NextResponse.json(
      { error: "코드 룩업 조회 실패" },
      { status: 500 }
    );
  }
}

// POST /api/lookups — 룩업 추가
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { category, code, label, color, sortOrder, description } = body;

    if (!category?.trim() || !code?.trim() || !label?.trim()) {
      return NextResponse.json(
        { error: "category, code, label은 필수입니다." },
        { status: 400 }
      );
    }

    const exists = await prisma.codeLookup.findUnique({
      where: {
        category_code: {
          category: category.trim(),
          code: code.trim(),
        },
      },
    });
    if (exists) {
      return NextResponse.json(
        { error: `"${category}/${code}" 룩업이 이미 존재합니다.` },
        { status: 409 }
      );
    }

    const lookup = await prisma.codeLookup.create({
      data: {
        category: category.trim(),
        code: code.trim(),
        label: label.trim(),
        color: color?.trim() || null,
        sortOrder: Number(sortOrder) || 0,
        description: description?.trim() || null,
        isSystem: false, // 사용자가 추가하는 건 항상 비시스템
      },
    });

    return NextResponse.json(
      {
        id: lookup.id,
        category: lookup.category,
        code: lookup.code,
        label: lookup.label,
        color: lookup.color,
        sortOrder: lookup.sortOrder,
        isSystem: lookup.isSystem,
        isActive: lookup.isActive,
        description: lookup.description,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/lookups error:", error);
    return NextResponse.json(
      { error: "코드 룩업 등록 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/lookups?id=1 — 룩업 수정
export async function PUT(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }

    const body = await request.json();
    const { label, color, sortOrder, isActive, description } = body;

    // 시스템 룩업이라도 label/color/sortOrder/description은 변경 허용
    // code/category 변경은 차단 (참조 무결성)
    const before = await prisma.codeLookup.findUnique({
      where: { id: Number(id) },
    });
    if (!before) {
      return NextResponse.json(
        { error: "룩업을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const lookup = await prisma.codeLookup.update({
      where: { id: Number(id) },
      data: {
        ...(label !== undefined && { label: label.trim() }),
        ...(color !== undefined && { color: color?.trim() || null }),
        ...(sortOrder !== undefined && { sortOrder: Number(sortOrder) || 0 }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
        ...(description !== undefined && {
          description: description?.trim() || null,
        }),
      },
    });

    return NextResponse.json({
      id: lookup.id,
      category: lookup.category,
      code: lookup.code,
      label: lookup.label,
      color: lookup.color,
      sortOrder: lookup.sortOrder,
      isSystem: lookup.isSystem,
      isActive: lookup.isActive,
      description: lookup.description,
    });
  } catch (error) {
    console.error("PUT /api/lookups error:", error);
    return NextResponse.json(
      { error: "코드 룩업 수정 실패" },
      { status: 500 }
    );
  }
}

// DELETE /api/lookups?id=1 — 룩업 삭제 (시스템 룩업은 차단)
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }

    const target = await prisma.codeLookup.findUnique({
      where: { id: Number(id) },
    });
    if (!target) {
      return NextResponse.json(
        { error: "룩업을 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    if (target.isSystem) {
      return NextResponse.json(
        { error: "시스템 룩업은 삭제할 수 없습니다. 비활성 처리를 사용하세요." },
        { status: 409 }
      );
    }

    await prisma.codeLookup.delete({ where: { id: Number(id) } });

    return NextResponse.json({ message: "코드 룩업이 삭제되었습니다." });
  } catch (error) {
    console.error("DELETE /api/lookups error:", error);
    return NextResponse.json(
      { error: "코드 룩업 삭제 실패" },
      { status: 500 }
    );
  }
}
