import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  WORK_HOURS_POLICY_DESCRIPTION,
  WORK_HOURS_POLICY_KEYS,
  validWorkHoursPolicyValue,
} from "@/lib/work-hours";

// GET /api/policies?search=...
export async function GET(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search") || "";

    const where: any = {};
    if (search) {
      where.OR = [
        { key: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    const policies = await prisma.policySetting.findMany({
      where,
      orderBy: { key: "asc" },
    });

    return NextResponse.json(
      policies.map((p) => ({
        key: p.key,
        value: p.value,
        description: p.description,
        updatedAt: p.updatedAt,
      }))
    );
  } catch (error) {
    console.error("GET /api/policies error:", error);
    return NextResponse.json(
      { error: "정책 조회 실패" },
      { status: 500 }
    );
  }
}

// PUT /api/policies?key=debounce_minutes — 값 수정만
export async function PUT(request: NextRequest) {
  try {
    const _auth = await requireAdmin();
    if (!_auth.ok) return _auth.response;

    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");
    if (!key) {
      return NextResponse.json({ error: "key 파라미터 필요" }, { status: 400 });
    }

    const body = await request.json();
    const { value } = body;

    if (value === undefined || value === null) {
      return NextResponse.json(
        { error: "value는 필수입니다." },
        { status: 400 }
      );
    }

    const trimmed = String(value).trim();

    // 알림 채널 키(notify_{type}_{app|email|push})는 코드에서 알림 타입을 추가할 때마다
    // 새로 생기므로, 행이 없어도 생성을 허용한다. 그 외 키는 기존대로 DB 직접 작업만 허용.
    const isNotifyChannelKey = /^notify_[a-z0-9_]+_(app|email|push)$/.test(key);
    // 근무시간 집계 정책 키(lib/work-hours)도 행이 없으면 정책 화면에서 처음 저장할 때 만든다.
    const isWorkHoursKey = (WORK_HOURS_POLICY_KEYS as readonly string[]).includes(key);
    if (isWorkHoursKey && !validWorkHoursPolicyValue(key, trimmed)) {
      return NextResponse.json(
        {
          error:
            key === "work_hours_break_per_stay_minutes"
              ? "1~1440 사이의 정수(분)를 입력하세요."
              : "0~1440 사이의 정수(분)를 입력하세요.",
        },
        { status: 400 }
      );
    }

    const exists = await prisma.policySetting.findUnique({
      where: { key },
    });

    if (!exists && !isNotifyChannelKey && !isWorkHoursKey) {
      return NextResponse.json(
        { error: `정책 "${key}"가 존재하지 않습니다. 정책 추가는 DB 직접 작업이 필요합니다.` },
        { status: 404 }
      );
    }

    const policy = exists
      ? await prisma.policySetting.update({
          where: { key },
          data: { value: trimmed },
        })
      : await prisma.policySetting.create({
          data: {
            key,
            value: trimmed,
            description: isWorkHoursKey
              ? WORK_HOURS_POLICY_DESCRIPTION
              : `알림 채널 설정 (${key}) — 설정 화면에서 자동 생성`,
          },
        });

    return NextResponse.json({
      key: policy.key,
      value: policy.value,
      description: policy.description,
      updatedAt: policy.updatedAt,
    });
  } catch (error) {
    console.error("PUT /api/policies error:", error);
    return NextResponse.json(
      { error: "정책 수정 실패" },
      { status: 500 }
    );
  }
}
