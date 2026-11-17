import { redirect } from "next/navigation";

// 예전 주소 /work-hours?… → 메뉴 화면 /?page=work-hours&… (같은 쿼리를 그대로 붙인다).
// redirect() 가 basePath(/hr)를 앞에 붙인다. 권한은 메뉴 화면의 관리자 가드·API 가 본다.
export default async function WorkHoursRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  q.set("page", "work-hours");
  for (const [k, v] of Object.entries(sp)) {
    if (k === "page" || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  redirect(`/?${q.toString()}`);
}
