import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeMacAddress } from "@/lib/macAddress";
import { requireAdmin } from "@/lib/auth-helpers";

// GET /api/devices?search=...&employeeId=...&deviceType=...&includeInactive=true
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";
    const employeeIdRaw = searchParams.get("employeeId");
    const deviceType = searchParams.get("deviceType") || "";
    const includeInactive = searchParams.get("includeInactive") === "true";

    const where: any = {};
    if (!includeInactive) where.isActive = true;
    if (employeeIdRaw) {
      const v = Number(employeeIdRaw);
      if (Number.isInteger(v)) where.employeeId = v;
    }
    if (deviceType) where.deviceType = deviceType;

    if (search) {
      const or: any[] = [
        { hostname: { contains: search, mode: "insensitive" } },
        { label: { contains: search, mode: "insensitive" } },
        { ipAddress: { contains: search, mode: "insensitive" } },
        { employee: { name: { contains: search, mode: "insensitive" } } },
        { employee: { employeeNo: { contains: search, mode: "insensitive" } } },
        // 원본 검색어로 macAddress 부분 일치
        { macAddress: { contains: search.toLowerCase(), mode: "insensitive" } },
      ];
      // 정규화한 값이 별도면 추가 (예: "AA:BB" → "aabb")
      const normalized = search.replace(/[:\-\s.]/g, "").toLowerCase();
      if (normalized && normalized !== search.toLowerCase()) {
        or.push({
          macAddress: { contains: normalized, mode: "insensitive" },
        });
      }
      where.OR = or;
    }

    const devices = await prisma.device.findMany({
      where,
      orderBy: [
        { employee: { employeeNo: "asc" } },
        { registeredAt: "desc" },
      ],
      include: {
        employee: { select: { id: true, employeeNo: true, name: true } },
      },
    });

    return NextResponse.json(
      devices.map((d) => ({
        id: d.id,
        employeeId: d.employeeId,
        employeeNo: d.employee.employeeNo,
        employeeName: d.employee.name,
        macAddress: d.macAddress,
        hostname: d.hostname,
        ipAddress: d.ipAddress,
        deviceType: d.deviceType,
        label: d.label,
        isActive: d.isActive,
        lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
        registeredAt: d.registeredAt.toISOString(),
      }))
    );
  } catch (error) {
    console.error("GET /api/devices error:", error);
    return NextResponse.json({ error: "디바이스 조회 실패" }, { status: 500 });
  }
}

// deviceType lookup 검증 헬퍼
async function validateDeviceType(code: string): Promise<string | null> {
  const lookup = await prisma.codeLookup.findUnique({
    where: {
      category_code: {
        category: "device_type",
        code,
      },
    },
  });
  if (!lookup || !lookup.isActive) {
    return `유형 "${code}"이 유효하지 않습니다. 코드 룩업의 device_type에서 활성 코드를 사용하세요.`;
  }
  return null;
}

// POST /api/devices — 디바이스 추가
export async function POST(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const body = await request.json();
    const { employeeId, macAddress, hostname, ipAddress, deviceType, label } =
      body;

    if (
      employeeId === undefined ||
      employeeId === null ||
      employeeId === "" ||
      !macAddress?.trim()
    ) {
      return NextResponse.json(
        { error: "직원, MAC 주소는 필수입니다." },
        { status: 400 }
      );
    }

    const employeeIdNum = Number(employeeId);
    if (!Number.isInteger(employeeIdNum)) {
      return NextResponse.json(
        { error: "employeeId는 정수여야 합니다." },
        { status: 400 }
      );
    }

    const normalizedMac = normalizeMacAddress(macAddress);
    if (!normalizedMac) {
      return NextResponse.json(
        { error: "MAC 주소 형식이 올바르지 않습니다 (16진수 12자리)." },
        { status: 400 }
      );
    }

    // 직원 존재 검증 (isActive 무관 — 비활성 직원도 디바이스 등록 가능)
    const emp = await prisma.employee.findUnique({
      where: { id: employeeIdNum },
    });
    if (!emp) {
      return NextResponse.json(
        { error: `직원 id ${employeeIdNum}를 찾을 수 없습니다.` },
        { status: 400 }
      );
    }

    // MAC 중복
    const dup = await prisma.device.findUnique({
      where: { macAddress: normalizedMac },
    });
    if (dup) {
      return NextResponse.json(
        { error: `MAC 주소가 이미 등록되어 있습니다.` },
        { status: 409 }
      );
    }

    // deviceType lookup 검증
    if (deviceType?.trim()) {
      const err = await validateDeviceType(deviceType.trim());
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }

    const device = await prisma.device.create({
      data: {
        employeeId: employeeIdNum,
        macAddress: normalizedMac,
        hostname: hostname?.trim() || null,
        ipAddress: ipAddress?.trim() || null,
        deviceType: deviceType?.trim() || null,
        label: label?.trim() || null,
        // lastSeenAt은 무시 — 폴링 데몬만 갱신
        // registeredAt은 default(now())
      },
      include: {
        employee: { select: { id: true, employeeNo: true, name: true } },
      },
    });

    return NextResponse.json(
      {
        id: device.id,
        employeeId: device.employeeId,
        employeeNo: device.employee.employeeNo,
        employeeName: device.employee.name,
        macAddress: device.macAddress,
        hostname: device.hostname,
        ipAddress: device.ipAddress,
        deviceType: device.deviceType,
        label: device.label,
        isActive: device.isActive,
        lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
        registeredAt: device.registeredAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/devices error:", error);
    return NextResponse.json({ error: "디바이스 등록 실패" }, { status: 500 });
  }
}

// PUT /api/devices?id=1
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
    const {
      employeeId,
      macAddress,
      hostname,
      ipAddress,
      deviceType,
      label,
      isActive,
    } = body;

    const before = await prisma.device.findUnique({ where: { id: idNum } });
    if (!before) {
      return NextResponse.json(
        { error: "디바이스를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    // employeeId 변경
    let employeeIdUpdate: number | undefined = undefined;
    if (employeeId !== undefined && employeeId !== null && employeeId !== "") {
      const v = Number(employeeId);
      if (!Number.isInteger(v)) {
        return NextResponse.json(
          { error: "employeeId는 정수여야 합니다." },
          { status: 400 }
        );
      }
      if (v !== before.employeeId) {
        const emp = await prisma.employee.findUnique({ where: { id: v } });
        if (!emp) {
          return NextResponse.json(
            { error: `직원 id ${v}를 찾을 수 없습니다.` },
            { status: 400 }
          );
        }
      }
      employeeIdUpdate = v;
    }

    // macAddress 변경
    let macUpdate: string | undefined = undefined;
    if (macAddress !== undefined) {
      const normalized = normalizeMacAddress(macAddress);
      if (!normalized) {
        return NextResponse.json(
          { error: "MAC 주소 형식이 올바르지 않습니다 (16진수 12자리)." },
          { status: 400 }
        );
      }
      if (normalized !== before.macAddress) {
        const dup = await prisma.device.findUnique({
          where: { macAddress: normalized },
        });
        if (dup && dup.id !== idNum) {
          return NextResponse.json(
            { error: "MAC 주소가 이미 등록되어 있습니다." },
            { status: 409 }
          );
        }
      }
      macUpdate = normalized;
    }

    // deviceType 변경 시 lookup 검증
    if (
      deviceType !== undefined &&
      deviceType !== null &&
      deviceType !== "" &&
      deviceType.trim() !== before.deviceType
    ) {
      const err = await validateDeviceType(deviceType.trim());
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }

    const device = await prisma.device.update({
      where: { id: idNum },
      data: {
        ...(employeeIdUpdate !== undefined && { employeeId: employeeIdUpdate }),
        ...(macUpdate !== undefined && { macAddress: macUpdate }),
        ...(hostname !== undefined && { hostname: hostname?.trim() || null }),
        ...(ipAddress !== undefined && {
          ipAddress: ipAddress?.trim() || null,
        }),
        ...(deviceType !== undefined && {
          deviceType: deviceType?.trim() || null,
        }),
        ...(label !== undefined && { label: label?.trim() || null }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
        // lastSeenAt / registeredAt 무시
      },
      include: {
        employee: { select: { id: true, employeeNo: true, name: true } },
      },
    });

    return NextResponse.json({
      id: device.id,
      employeeId: device.employeeId,
      employeeNo: device.employee.employeeNo,
      employeeName: device.employee.name,
      macAddress: device.macAddress,
      hostname: device.hostname,
      ipAddress: device.ipAddress,
      deviceType: device.deviceType,
      label: device.label,
      isActive: device.isActive,
      lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
      registeredAt: device.registeredAt.toISOString(),
    });
  } catch (error) {
    console.error("PUT /api/devices error:", error);
    return NextResponse.json({ error: "디바이스 수정 실패" }, { status: 500 });
  }
}

// DELETE /api/devices?id=1
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

    const target = await prisma.device.findUnique({ where: { id: idNum } });
    if (!target) {
      return NextResponse.json(
        { error: "디바이스를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const presenceCount = await prisma.presenceRaw.count({
      where: { deviceId: idNum },
    });
    if (presenceCount > 0) {
      return NextResponse.json(
        {
          error: `이 디바이스로 수집된 폴링 데이터 ${presenceCount}건이 있습니다. 비활성 처리를 사용하세요.`,
        },
        { status: 409 }
      );
    }

    await prisma.device.delete({ where: { id: idNum } });

    return NextResponse.json({ message: "디바이스가 삭제되었습니다." });
  } catch (error) {
    console.error("DELETE /api/devices error:", error);
    return NextResponse.json({ error: "디바이스 삭제 실패" }, { status: 500 });
  }
}
