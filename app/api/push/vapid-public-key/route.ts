import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";

export async function GET() {
  const r = await requireSession();
  if (!r.ok) return r.response;
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return NextResponse.json({ error: "VAPID_PUBLIC_KEY 미설정" }, { status: 500 });
  }
  return NextResponse.json({ key });
}
