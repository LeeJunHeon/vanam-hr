"use client";

import { CalendarDays } from "lucide-react";

export default function CalendarPage() {
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Calendar 연동</h1>
        <p className="text-sm text-gray-500 mt-1">Google Calendar 외근·출장 자동 동기화 (색상 기반)</p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
        <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <CalendarDays size={24} className="text-blue-500" />
        </div>
        <h2 className="text-base font-semibold text-gray-700 mb-1">
          Calendar 연동 (예정)
        </h2>
        <p className="text-sm text-gray-400">
          Phase 3-D에서 calendar_color_mappings + external_calendars OAuth 토큰 구현 예정
        </p>
      </div>
    </div>
  );
}
