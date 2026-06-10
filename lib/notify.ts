// 알림 생성 공용 헬퍼.
// notification_prefs에서 enabled=false인 직원만 제외(행 없으면 켜짐=기본 수신).
// 실패해도 호출부 흐름을 깨지 않도록 try/catch로 감싸 사용할 것(여기선 throw 가능, 호출부에서 catch).

import { prisma } from "@/lib/prisma";

interface CreateNotificationArgs {
  employeeIds: number[];       // 받을 직원들
  type: string;                // 'approval_request' 등
  title: string;
  body?: string | null;
  linkPage?: string | null;    // 'approval' | 'field-trip' 등
  linkRefId?: number | bigint | null;
  sourceType?: string | null;  // 'attendance_request' | 'trip'
}

export async function createNotifications(args: CreateNotificationArgs): Promise<number> {
  const { employeeIds, type, title, body, linkPage, linkRefId, sourceType } = args;
  // 중복 제거 + 유효값만
  const uniqueIds = Array.from(new Set(employeeIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (uniqueIds.length === 0) return 0;

  // 이 type에 대해 enabled=false로 꺼둔 직원 조회 → 제외
  const disabledRows = await prisma.notificationPref.findMany({
    where: { employeeId: { in: uniqueIds }, type, enabled: false },
    select: { employeeId: true },
  });
  const disabled = new Set(disabledRows.map((r) => r.employeeId));
  const targets = uniqueIds.filter((id) => !disabled.has(id));
  if (targets.length === 0) return 0;

  await prisma.notification.createMany({
    data: targets.map((employeeId) => ({
      employeeId,
      type,
      title,
      body: body ?? null,
      linkPage: linkPage ?? null,
      linkRefId: linkRefId != null ? BigInt(linkRefId) : null,
      sourceType: sourceType ?? null,
    })),
  });
  return targets.length;
}
