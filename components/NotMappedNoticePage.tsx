"use client";

import { UserX } from "lucide-react";

interface NotMappedNoticePageProps {
  userName?: string | null;
  userEmail?: string | null;
}

/**
 * SSO 로그인은 됐지만 hr.employees에 매핑되지 않은 사용자에게 보여주는 안내 페이지.
 * - 관리자(role='admin')는 매핑 없이도 admin API에 접근 가능하므로 이 페이지를 보지 않는다.
 * - 일반 사용자는 본인 데이터가 없으므로 모든 본인 페이지가 403을 반환 → 안내만 표시.
 */
export default function NotMappedNoticePage({
  userName,
  userEmail,
}: NotMappedNoticePageProps) {
  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="max-w-lg w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-6">
        <div className="flex items-center justify-center w-16 h-16 mx-auto rounded-2xl bg-amber-50">
          <UserX size={28} className="text-amber-500" />
        </div>

        <div className="text-center space-y-2">
          <h2 className="text-xl font-bold text-gray-900">
            등록되지 않은 사용자
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed">
            현재 인사 시스템에 본인 정보가 등록되지 않았습니다.
            <br />
            담당자에게 등록을 요청해주세요.
          </p>
        </div>

        <div className="rounded-xl bg-gray-50 border border-gray-100 p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">이름</span>
            <span className="font-medium text-gray-900">{userName ?? "-"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">이메일</span>
            <span className="font-medium text-gray-900 break-all">
              {userEmail ?? "-"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
