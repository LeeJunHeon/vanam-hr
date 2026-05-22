"use client";

import { useEffect, useState } from "react";

export interface CurrentEmployeeOption {
  id: number;
  employeeNo: string;
  name: string;
  departmentName: string | null;
}

export interface MeInfo {
  id: number | null;
  employeeNo: string | null;
  name: string | null;
  email: string | null;
  departmentId: number | null;
  departmentName: string | null;
  positionId: number | null;
  positionName: string | null;
  isActive: boolean;
  role: string;
  isAdmin: boolean;
  isMapped: boolean;
}

// SSO + 권한 시대 훅 — /api/me 1회 호출로 본인 정보 + admin 여부 획득.
// 같은 인터페이스 ({currentId, current, loading, employees:[], setCurrentId})를 유지하면서
// 추가로 me / isAdmin / isMapped를 노출한다.
export function useCurrentEmployee() {
  const [me, setMe] = useState<MeInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) {
            setMe(null);
            setLoading(false);
          }
          return;
        }
        const data: MeInfo = await res.json();
        if (!cancelled) {
          setMe(data);
          setLoading(false);
        }
      } catch (e) {
        console.error("useCurrentEmployee /api/me error:", e);
        if (!cancelled) {
          setMe(null);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const current: CurrentEmployeeOption | null =
    me && me.id !== null
      ? {
          id: me.id,
          employeeNo: me.employeeNo ?? "",
          name: me.name ?? "",
          departmentName: me.departmentName,
        }
      : null;

  return {
    currentId: me?.id ?? null,
    current,
    loading,
    me,
    isAdmin: me?.isAdmin ?? false,
    isMapped: me?.isMapped ?? false,
    // 호환성 stub (사용처에서 호출하지만 더 이상 의미 없음)
    employees: [] as CurrentEmployeeOption[],
    setCurrentId: (_id: number) => {},
  };
}
