import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession, isAdminSession } from "@/lib/auth-helpers";
import {
  TEAM_SCHEDULE_KEYS,
  getTeamScheduleSettings,
  isDefaultTeamScheduleCategory,
} from "@/lib/team-schedule-notify";

export const dynamic = "force-dynamic";

// GET: 현재 설정 + 선택 가능한 카테고리 목록
export async function GET() {
  const s = await requireSession();
  if (!s.ok) return s.response;
  if (!isAdminSession(s.session))
    return NextResponse.json({ error: "관리자만 접근 가능합니다." }, { status: 403 });

  const settings = await getTeamScheduleSettings();
  const categories = await prisma.attendanceCategory.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true, type: true },
    orderBy: { id: "asc" },
  });
  // 미설정(null)이면 기본 규칙으로 계산된 목록을 "현재 선택"으로 보여준다
  const effectiveCodes =
    settings.categoryCodes ??
    categories.filter(isDefaultTeamScheduleCategory).map((c) => c.code);

  return NextResponse.json({
    enabled: settings.enabled,
    includeApprovers: settings.includeApprovers,
    categoryCodes: effectiveCodes,
    isDefault: settings.categoryCodes === null,
    categories,
  });
}

// PUT: 설정 저장
export async function PUT(request: NextRequest) {
  const s = await requireSession();
  if (!s.ok) return s.response;
  if (!isAdminSession(s.session))
    return NextResponse.json({ error: "관리자만 접근 가능합니다." }, { status: 403 });

  const body = await request.json();
  const enabled = Boolean(body.enabled);
  const includeApprovers = Boolean(body.includeApprovers);
  const codes: string[] = Array.isArray(body.categoryCodes)
    ? body.categoryCodes.filter((c: unknown): c is string => typeof c === "string")
    : [];

  const upserts = [
    { key: TEAM_SCHEDULE_KEYS.enabled, value: String(enabled), description: "팀 일정 알림 기능 on/off" },
    { key: TEAM_SCHEDULE_KEYS.includeApprovers, value: String(includeApprovers), description: "팀 일정 알림에 결재자 포함 여부" },
    { key: TEAM_SCHEDULE_KEYS.categories, value: JSON.stringify(codes), description: "팀 일정 알림 대상 카테고리 code 목록(JSON)" },
  ];
  for (const u of upserts) {
    await prisma.policySetting.upsert({
      where: { key: u.key },
      create: { key: u.key, value: u.value, description: u.description },
      update: { value: u.value, updatedAt: new Date() },
    });
  }
  return NextResponse.json({ ok: true, enabled, includeApprovers, categoryCodes: codes });
}
