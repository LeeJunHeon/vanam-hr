import webpush from "web-push";
import { prisma } from "@/lib/prisma";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) {
    throw new Error("VAPID 환경변수(VAPID_SUBJECT/PUBLIC_KEY/PRIVATE_KEY)가 없습니다.");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export type PushPayload = {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  icon?: string;
};

export type PushResult = { sent: number; failed: number; pruned: number };

/**
 * 지정한 직원들의 활성 구독으로 푸시 발송.
 * - 410/404(만료·무효 구독)은 is_active=false 로 자동 정리.
 * - 반환: { sent, failed, pruned }
 */
export async function sendPushToEmployees(
  employeeIds: number[],
  payload: PushPayload,
): Promise<PushResult> {
  const ids = Array.from(
    new Set(employeeIds.filter((id) => Number.isInteger(id) && id > 0)),
  );
  if (ids.length === 0) return { sent: 0, failed: 0, pruned: 0 };

  ensureConfigured();

  const subs = await prisma.pushSubscription.findMany({
    where: { employeeId: { in: ids }, isActive: true },
  });
  if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0 };

  const data = JSON.stringify({
    title: payload.title,
    body: payload.body ?? "",
    url: payload.url ?? "/",
    tag: payload.tag,
    icon: payload.icon ?? "/icon-192.png",
  });

  const okEndpoints: string[] = [];
  const deadEndpoints: string[] = [];
  let failed = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dhKey, auth: s.authKey } },
          data,
        );
        okEndpoints.push(s.endpoint);
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          deadEndpoints.push(s.endpoint);
        } else {
          failed++;
          console.error("[webpush] 발송 실패", statusCode, err);
        }
      }
    }),
  );

  if (deadEndpoints.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: { endpoint: { in: deadEndpoints } },
      data: { isActive: false },
    });
  }
  if (okEndpoints.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: { endpoint: { in: okEndpoints } },
      data: { lastUsedAt: new Date() },
    });
  }

  return { sent: okEndpoints.length, failed, pruned: deadEndpoints.length };
}
