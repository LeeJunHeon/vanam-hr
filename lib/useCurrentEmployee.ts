"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

export interface CurrentEmployeeOption {
  id: number;
  employeeNo: string;
  name: string;
  departmentName: string | null;
}

// SSO 도입 후: session.user.employeeId 자동 사용
// 같은 인터페이스 유지 — 호출처 코드 변경 최소화
export function useCurrentEmployee() {
  const { data: session, status } = useSession();
  const [current, setCurrent] = useState<CurrentEmployeeOption | null>(null);
  const [loading, setLoading] = useState(true);

  const employeeId = (session?.user as any)?.employeeId ?? null;
  const employeeNo = (session?.user as any)?.employeeNo ?? null;
  const userName = session?.user?.name ?? "";

  useEffect(() => {
    if (status === "loading") {
      setLoading(true);
      return;
    }

    if (!employeeId) {
      setCurrent(null);
      setLoading(false);
      return;
    }

    // 본인 정보 (부서명 포함) 1회 조회
    (async () => {
      try {
        const res = await fetch(`/api/employees?id=${employeeId}`);
        if (res.ok) {
          const data = await res.json();
          // /api/employees는 id 쿼리 지원 X일 수 있음 → 전체 조회 후 필터
          const list = Array.isArray(data) ? data : [data];
          const found = list.find((e: any) => e.id === employeeId);
          if (found) {
            setCurrent({
              id: found.id,
              employeeNo: found.employeeNo ?? employeeNo ?? "",
              name: found.name ?? userName,
              departmentName: found.departmentName ?? null,
            });
          } else {
            // 못 찾으면 session 정보로 최소 fallback
            setCurrent({
              id: employeeId,
              employeeNo: employeeNo ?? "",
              name: userName,
              departmentName: null,
            });
          }
        } else {
          setCurrent({
            id: employeeId,
            employeeNo: employeeNo ?? "",
            name: userName,
            departmentName: null,
          });
        }
      } catch (e) {
        console.error("useCurrentEmployee fetch error:", e);
        setCurrent({
          id: employeeId,
          employeeNo: employeeNo ?? "",
          name: userName,
          departmentName: null,
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [employeeId, employeeNo, userName, status]);

  return {
    currentId: employeeId as number | null,
    current,
    loading,
    // 호환성 stub (사용처에서 호출하지만 더 이상 의미 없음)
    employees: [] as CurrentEmployeeOption[],
    setCurrentId: (_id: number) => {},
  };
}
