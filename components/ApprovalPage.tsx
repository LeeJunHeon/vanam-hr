"use client";

import { CheckSquare } from "lucide-react";

export default function ApprovalPage() {
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">결재함</h1>
        <p className="text-sm text-gray-500 mt-1">결재 대기 / 처리 완료 내역</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
        <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <CheckSquare size={24} className="text-blue-500" />
        </div>
        <h2 className="text-base font-semibold text-gray-700 mb-1">
          결재함 (예정)
        </h2>
        <p className="text-sm text-gray-400">
          Phase 3-D에서 approval_inbox + 24시간 자동 위임 로직 구현 예정
        </p>
      </div>
    </div>
  );
}
