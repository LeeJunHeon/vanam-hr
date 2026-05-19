"use client";

import { LogIn, LogOut, Calendar, Plane, Bell } from "lucide-react";

// Phase 3-B: 더미 데이터 (Phase 3-C에서 실제 API 연동)
const DUMMY = {
  todayIn: "09:02",
  todayOut: "18:15",
  monthlyDays: 14,
  leaveRemaining: 12,
};

export default function DashboardPage() {
  const stats = [
    {
      label: "오늘 출근",
      value: DUMMY.todayIn,
      sub: "정상 출근",
      icon: LogIn,
      color: "text-blue-600",
      bg: "bg-blue-50",
    },
    {
      label: "오늘 퇴근",
      value: DUMMY.todayOut,
      sub: "근무 중",
      icon: LogOut,
      color: "text-rose-600",
      bg: "bg-rose-50",
    },
    {
      label: "이번달 근무일",
      value: `${DUMMY.monthlyDays}일`,
      sub: "기준일까지",
      icon: Calendar,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
    },
    {
      label: "연차 잔여",
      value: `${DUMMY.leaveRemaining}일`,
      sub: "올해 사용 가능",
      icon: Plane,
      color: "text-amber-600",
      bg: "bg-amber-50",
    },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* 페이지 헤더 */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">대시보드</h1>
        <p className="text-sm text-gray-500 mt-1">
          오늘의 근태 현황과 이번달 통계를 확인하세요
        </p>
      </div>

      {/* 통계 카드 4개 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s, i) => (
          <div
            key={i}
            className="bg-white rounded-2xl border border-gray-100 p-5"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-gray-500 font-medium">{s.label}</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">{s.value}</p>
                <p className="text-xs text-gray-400 mt-1">{s.sub}</p>
              </div>
              <div className={`p-2.5 rounded-xl ${s.bg}`}>
                <s.icon size={20} className={s.color} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 최근 알림 placeholder */}
      <div className="bg-white rounded-2xl border border-gray-100">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <Bell size={16} className="text-gray-400" />
          <h2 className="font-bold text-gray-900">최근 알림</h2>
        </div>
        <div className="px-5 py-8 text-center text-sm text-gray-400">
          Phase 3-C에서 알림 목록 구현 예정
        </div>
      </div>

      {/* Phase 안내 */}
      <p className="text-xs text-gray-400 text-center">
        ※ 현재 더미 데이터로 표시 중. 실제 데이터 연동은 Phase 3-C 예정
      </p>
    </div>
  );
}
