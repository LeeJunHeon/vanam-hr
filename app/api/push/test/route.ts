import { NextRequest, NextResponse } from "next/server";
import { getTargetEmployeeId } from "@/lib/auth-helpers";
import { sendPushToEmployees } from "@/lib/webpush";

// 테스트용: 호출 시 본인에게 푸시 발송 (관리자는 ?employeeId=N 으로 특정 직원 지정 가능)
export async function GET(request: NextRequest) {
  const r = await getTargetEmployeeId(request);
  if (!r.ok) return r.response;
  const { employeeId } = r;

  const result = await sendPushToEmployees([employeeId], {
    title: "VanaM 테스트 알림",
    body: "푸시 알림이 정상적으로 동작합니다.",
    url: "/",
    tag: "push-test",
  });

  return NextResponse.json({ ok: true, targetEmployeeId: employeeId, ...result });
}
