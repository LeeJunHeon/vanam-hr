"use client";

import { UserCircle, AlertCircle } from "lucide-react";
import {
  useCurrentEmployee,
  CurrentEmployeeOption,
} from "@/lib/useCurrentEmployee";

interface Props {
  onChange?: (employee: CurrentEmployeeOption | null) => void;
}

export default function CurrentEmployeeSelector({ onChange }: Props) {
  const { employees, currentId, setCurrentId, loading } = useCurrentEmployee();

  if (loading) return null;

  if (employees.length === 0) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
        <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold text-amber-900">활성 직원이 없습니다</p>
          <p className="text-amber-700 mt-1">
            먼저 "직원 관리" 페이지에서 본인을 등록하세요.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-sky-50 border border-sky-200 rounded-2xl p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-center gap-2 text-sm text-sky-900 shrink-0">
        <UserCircle size={18} />
        <span className="font-semibold">현재 본인</span>
      </div>
      <select
        value={currentId ?? ""}
        onChange={(e) => {
          const id = Number(e.target.value);
          setCurrentId(id);
          onChange?.(employees.find((emp) => emp.id === id) ?? null);
        }}
        className="flex-1 px-3 py-2 border border-sky-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-sky-400"
      >
        {employees.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} ({e.employeeNo}) - {e.departmentName ?? "부서 미지정"}
          </option>
        ))}
      </select>
      <p className="text-[10px] text-sky-700 sm:text-xs">
        ⚠️ Phase 7 SSO 연동 전 임시 선택기
      </p>
    </div>
  );
}
