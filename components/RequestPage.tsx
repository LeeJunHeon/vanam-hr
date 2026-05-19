"use client";

import { FileText } from "lucide-react";

export default function RequestPage() {
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">휴가/근태 신청</h1>
        <p className="text-sm text-gray-500 mt-1">휴가·반차·병가·근태 정정 신청</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
        <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <FileText size={24} className="text-blue-500" />
        </div>
        <h2 className="text-base font-semibold text-gray-700 mb-1">
          신청 페이지 (예정)
        </h2>
        <p className="text-sm text-gray-400">
          Phase 3-D에서 leave_requests + attendance_correction_requests 폼 구현 예정
        </p>
      </div>
    </div>
  );
}
