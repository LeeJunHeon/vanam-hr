import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";

interface CreateNotificationArgs {
  employeeIds: number[];
  type: string;                // 'approval_request' | 'trip_request' | 'trip_invite' | 'approval_result' | 'trip_result' | 'trip_decline' | 'trip_remove' | 'cancel'
  title: string;
  body?: string | null;
  linkPage?: string | null;
  linkRefId?: number | bigint | null;
  sourceType?: string | null;
}

// 전역 정책(policy_settings)에서 이 type의 앱/이메일 on 여부를 읽는다.
// 키 규칙: notify_{type}_app / notify_{type}_email. 값은 'true'/'false' 문자열.
// 키가 없으면 기본값: 앱=true(수신), 이메일=false(미수신) — 안전.
async function getChannelFlags(type: string): Promise<{ app: boolean; email: boolean }> {
  const appKey = `notify_${type}_app`;
  const emailKey = `notify_${type}_email`;
  const rows = await prisma.policySetting.findMany({
    where: { key: { in: [appKey, emailKey] } },
    select: { key: true, value: true },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const appRaw = map.get(appKey);
  const emailRaw = map.get(emailKey);
  return {
    app: appRaw !== undefined ? appRaw === "true" : true,    // 기본 켜짐
    email: emailRaw !== undefined ? emailRaw === "true" : false, // 기본 꺼짐
  };
}

// 알림 발송 공용 통로: 앱 알림 + 이메일(전역 정책에 따라).
// 나중에 푸시 등 채널 추가 시 이 함수에 블록만 더하면 된다.
export async function createNotifications(args: CreateNotificationArgs): Promise<number> {
  const { employeeIds, type, title, body, linkPage, linkRefId, sourceType } = args;
  const uniqueIds = Array.from(new Set(employeeIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (uniqueIds.length === 0) return 0;

  // 전역 정책으로 채널 on/off 결정
  const flags = await getChannelFlags(type);

  // ── 앱 알림 ──
  if (flags.app) {
    await prisma.notification.createMany({
      data: uniqueIds.map((employeeId) => ({
        employeeId,
        type,
        title,
        body: body ?? null,
        linkPage: linkPage ?? null,
        linkRefId: linkRefId != null ? BigInt(linkRefId) : null,
        sourceType: sourceType ?? null,
      })),
    });
  }

  // ── 이메일 ──
  if (flags.email) {
    try {
      const emps = await prisma.employee.findMany({
        where: { id: { in: uniqueIds }, isActive: true },
        select: { email: true },
      });
      const subject = `[VanaM HR] ${title}`;
      const text = body ?? title;
      // 각자에게 발송 (실패해도 다음 사람 계속)
      for (const e of emps) {
        if (e.email) {
          await sendEmail(e.email, subject, text);
        }
      }
    } catch (e) {
      console.error("[notify] 이메일 발송 중 오류:", e);
    }
  }

  // 반환값: 앱 알림 대상 수(기존 호환). 이메일은 별개로 흘려보냄.
  return flags.app ? uniqueIds.length : 0;
}
