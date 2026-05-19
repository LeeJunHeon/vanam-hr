"use client";

import { useState, useEffect, useCallback } from "react";

export interface CurrentEmployeeOption {
  id: number;
  employeeNo: string;
  name: string;
  departmentName: string | null;
}

const STORAGE_KEY = "vanam-hr:currentEmployeeId";

// 본인 선택기 훅 (localStorage 영속화)
// my-attendance / request / approval 3개 페이지가 공유
// Phase 7 NextAuth 연동 시 session.user.dbId → employee.userId 매핑으로 교체 예정
export function useCurrentEmployee() {
  const [employees, setEmployees] = useState<CurrentEmployeeOption[]>([]);
  const [currentId, setCurrentIdState] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/employees?includeInactive=false");
        if (!res.ok) return;
        const data = await res.json();
        const opts: CurrentEmployeeOption[] = data.map((e: any) => ({
          id: e.id,
          employeeNo: e.employeeNo,
          name: e.name,
          departmentName: e.departmentName,
        }));
        setEmployees(opts);

        const stored =
          typeof window !== "undefined"
            ? localStorage.getItem(STORAGE_KEY)
            : null;
        const storedNum = stored ? Number(stored) : null;
        if (storedNum && opts.some((o) => o.id === storedNum)) {
          setCurrentIdState(storedNum);
        } else if (opts.length > 0) {
          setCurrentIdState(opts[0].id);
          if (typeof window !== "undefined") {
            localStorage.setItem(STORAGE_KEY, String(opts[0].id));
          }
        }
      } catch (e) {
        console.error("useCurrentEmployee fetch error:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const setCurrentId = useCallback((id: number) => {
    setCurrentIdState(id);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, String(id));
    }
  }, []);

  const current = employees.find((e) => e.id === currentId) ?? null;

  return { employees, currentId, current, setCurrentId, loading };
}
