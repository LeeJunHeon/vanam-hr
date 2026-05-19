"use client";

import { useState } from "react";
import { Building2, Briefcase } from "lucide-react";
import DepartmentsSection from "./DepartmentsSection";
import PositionsSection from "./PositionsSection";

type Tab = "departments" | "positions";

export default function OrgPage() {
  const [activeTab, setActiveTab] = useState<Tab>("departments");

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 헤더 */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">부서/직급</h1>
        <p className="text-sm text-gray-500 mt-0.5">조직 마스터 데이터를 관리합니다</p>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        <button
          onClick={() => setActiveTab("departments")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
            activeTab === "departments"
              ? "bg-white text-blue-600 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <Building2 size={16} /> 부서
        </button>
        <button
          onClick={() => setActiveTab("positions")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
            activeTab === "positions"
              ? "bg-white text-blue-600 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <Briefcase size={16} /> 직급
        </button>
      </div>

      {/* 활성 섹션 */}
      {activeTab === "departments" ? <DepartmentsSection /> : <PositionsSection />}
    </div>
  );
}
