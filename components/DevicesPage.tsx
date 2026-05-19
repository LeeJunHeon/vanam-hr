"use client";

import { Smartphone } from "lucide-react";

export default function DevicesPage() {
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">디바이스 관리</h1>
        <p className="text-sm text-gray-500 mt-1">사내 WiFi 폴링 대상 디바이스 + ipTIME 호스트명 매핑</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
        <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Smartphone size={24} className="text-blue-500" />
        </div>
        <h2 className="text-base font-semibold text-gray-700 mb-1">
          디바이스 관리 (예정)
        </h2>
        <p className="text-sm text-gray-400">
          Phase 3-C에서 devices CRUD + iptime_host_mapping 구현 예정
        </p>
      </div>
    </div>
  );
}
