import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

// targetId가 ancestorId의 자손인지 확인 (순환 참조 방지)
// 시작: parentId = ancestorId. 거기서 부모를 따라 올라가면서 targetId 만나면 true.
// 즉, "targetId를 ancestorId의 부모로 두려고 할 때" — ancestorId가 targetId의 후손이면 안 됨.
async function isDescendant(
  targetId: number,
  ancestorId: number
): Promise<boolean> {
  let currentId: number | null = ancestorId;
  for (let depth = 0; depth < 10 && currentId !== null; depth++) {
    if (currentId === targetId) return true;
    const node: { parentId: number | null } | null =
      await prisma.department.findUnique({
        where: { id: currentId },
        select: { parentId: true },
      });
    if (!node) return false;
    currentId = node.parentId;
  }
  return false;
}

// GET /api/departments?search=...&includeInactive=true
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

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

    const departments = await prisma.department.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      include: { parent: { select: { id: true, code: true, name: true } } },
    });

    return NextResponse.json(
      departments.map((d) => ({
        id: d.id,
        code: d.code,
        name: d.name,
        parentId: d.parentId,
        parentCode: d.parent?.code ?? null,
        parentName: d.parent?.name ?? null,
        sortOrder: d.sortOrder,
        isActive: d.isActive,
      }))
    );
  } catch (error) {
    console.error("GET /api/departments error:", error);
    return NextResponse.json({ error: "부서 조회 실패" }, { status: 500 });
  }
}

// POST /api/departments — 부서 추가
export async function POST(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const body = await request.json();
    const { code, name, parentId, sortOrder } = body;

    if (!code?.trim() || !name?.trim()) {
      return NextResponse.json(
        { error: "code, name은 필수입니다." },
        { status: 400 }
      );
    }

    const exists = await prisma.department.findUnique({
      where: { code: code.trim() },
    });
    if (exists) {
      return NextResponse.json(
        { error: `코드 "${code}"가 이미 존재합니다.` },
        { status: 409 }
      );
    }

    // parentId 검증
    let parentIdNum: number | null = null;
    if (parentId !== undefined && parentId !== null && parentId !== "") {
      parentIdNum = Number(parentId);
      if (!Number.isInteger(parentIdNum)) {
        return NextResponse.json(
          { error: "parentId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      const parent = await prisma.department.findUnique({
        where: { id: parentIdNum },
      });
      if (!parent) {
        return NextResponse.json(
          { error: `상위 부서 id ${parentIdNum}를 찾을 수 없습니다.` },
          { status: 400 }
        );
      }
    }

    const dept = await prisma.department.create({
      data: {
        code: code.trim(),
        name: name.trim(),
        parentId: parentIdNum,
        sortOrder: Number(sortOrder) || 0,
      },
      include: { parent: { select: { id: true, code: true, name: true } } },
    });

    return NextResponse.json(
      {
        id: dept.id,
        code: dept.code,
        name: dept.name,
        parentId: dept.parentId,
        parentCode: dept.parent?.code ?? null,
        parentName: dept.parent?.name ?? null,
        sortOrder: dept.sortOrder,
        isActive: dept.isActive,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/departments error:", error);
    return NextResponse.json({ error: "부서 등록 실패" }, { status: 500 });
  }
}

// PUT /api/departments?id=1 — 부서 수정 (code 제외)
export async function PUT(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const body = await request.json();
    const { name, parentId, sortOrder, isActive } = body;

    const before = await prisma.department.findUnique({
      where: { id: idNum },
    });
    if (!before) {
      return NextResponse.json(
        { error: "부서를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // parentId 검증 (parentId 키가 명시적으로 들어왔을 때만 처리)
    let parentIdUpdate: number | null | undefined = undefined;
    if (parentId !== undefined) {
      if (parentId === null || parentId === "") {
        parentIdUpdate = null;
      } else {
        const parentIdNum = Number(parentId);
        if (!Number.isInteger(parentIdNum)) {
          return NextResponse.json(
            { error: "parentId는 정수여야 합니다." },
            { status: 400 }
          );
        }
        if (parentIdNum === idNum) {
          return NextResponse.json(
            { error: "자기 자신을 상위 부서로 설정할 수 없습니다." },
            { status: 400 }
          );
        }
        const parent = await prisma.department.findUnique({
          where: { id: parentIdNum },
        });
        if (!parent) {
          return NextResponse.json(
            { error: `상위 부서 id ${parentIdNum}를 찾을 수 없습니다.` },
            { status: 400 }
          );
        }
        // 순환 참조 차단: parentIdNum가 자기(idNum)의 자손이면 안 됨
        if (await isDescendant(idNum, parentIdNum)) {
          return NextResponse.json(
            { error: "순환 참조가 발생합니다. 하위 부서를 상위로 지정할 수 없습니다." },
            { status: 400 }
          );
        }
        parentIdUpdate = parentIdNum;
      }
    }

    const dept = await prisma.department.update({
      where: { id: idNum },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(parentIdUpdate !== undefined && { parentId: parentIdUpdate }),
        ...(sortOrder !== undefined && { sortOrder: Number(sortOrder) || 0 }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
      include: { parent: { select: { id: true, code: true, name: true } } },
    });

    return NextResponse.json({
      id: dept.id,
      code: dept.code,
      name: dept.name,
      parentId: dept.parentId,
      parentCode: dept.parent?.code ?? null,
      parentName: dept.parent?.name ?? null,
      sortOrder: dept.sortOrder,
      isActive: dept.isActive,
    });
  } catch (error) {
    console.error("PUT /api/departments error:", error);
    return NextResponse.json({ error: "부서 수정 실패" }, { status: 500 });
  }
}

// DELETE /api/departments?id=1 — 부서 삭제
export async function DELETE(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id 파라미터 필요" }, { status: 400 });
    }
    const idNum = Number(id);

    const target = await prisma.department.findUnique({
      where: { id: idNum },
    });
    if (!target) {
      return NextResponse.json(
        { error: "부서를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const [childCount, empCount, lineCount] = await Promise.all([
      prisma.department.count({ where: { parentId: idNum } }),
      prisma.employee.count({ where: { departmentId: idNum } }),
      prisma.approvalLine.count({ where: { departmentId: idNum } }),
    ]);

    if (childCount > 0 || empCount > 0 || lineCount > 0) {
      const refs: string[] = [];
      if (childCount > 0) refs.push(`하위 부서 ${childCount}건`);
      if (empCount > 0) refs.push(`소속 직원 ${empCount}건`);
      if (lineCount > 0) refs.push(`결재선 ${lineCount}건`);
      return NextResponse.json(
        {
          error: `이 부서를 사용 중입니다 (${refs.join(", ")}). 비활성 처리를 사용하세요.`,
        },
        { status: 409 }
      );
    }

    await prisma.department.delete({ where: { id: idNum } });

    return NextResponse.json({ message: "부서가 삭제되었습니다." });
  } catch (error) {
    console.error("DELETE /api/departments error:", error);
    return NextResponse.json({ error: "부서 삭제 실패" }, { status: 500 });
  }
}
