import { auth } from "@/auth";

export default async function Home() {
  const session = await auth();

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-md p-8 space-y-4 text-center">
        <h1 className="text-2xl font-bold text-gray-900">VanaM 인사·근태</h1>
        <p className="text-sm text-gray-500">
          {session?.user?.name ?? session?.user?.email ?? "사용자"} 님, 환영합니다.
        </p>
        <p className="text-xs text-gray-400">Phase 3-A 초기 셋업 완료</p>
      </div>
    </main>
  );
}
