"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Plus,
  Edit,
  Trash2,
  Loader2,
  X,
  Download,
  User,
  Link as LinkIcon,
  Info,
} from "lucide-react";
import { exportCSV } from "@/lib/csvUtils";
import DatePicker from "@/components/DatePicker";

interface Employee {
  id: number;
  employeeNo: string | null;
  userId: number | null;
  name: string;
  email: string | null;
  departmentId: number | null;
  departmentCode: string | null;
  departmentName: string | null;
  positionId: number | null;
  positionCode: string | null;
  positionName: string | null;
  phone: string | null;
  hiredAt: string | null; // "YYYY-MM-DD" or null
  resignedAt: string | null;
  isActive: boolean;
  note: string | null;
}

interface DeptOption {
  id: number;
  code: string;
  name: string;
}
interface PositionOption {
  id: number;
  code: string;
  name: string;
}
interface UserOption {
  id: number;
  name: string;
  email: string | null;
  role: string | null;
}

const today = () => new Date().toISOString().split("T")[0];

const EMPTY_FORM = {
  employeeNo: "",
  userId: "" as "" | string,
  name: "",
  email: "",
  departmentId: "" as "" | string,
  positionId: "" as "" | string,
  phone: "",
  hiredAt: today(),
  resignedAt: "",
  note: "",
};

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState<string>("");
  const [positionFilter, setPositionFilter] = useState<string>("");
  const [includeInactive, setIncludeInactive] = useState(false);

  // 외부 참조 마스터
  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [positions, setPositions] = useState<PositionOption[]>([]);
  const [availableUsers, setAvailableUsers] = useState<UserOption[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Employee | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // 마스터 1회 로드 (departments / positions)
  useEffect(() => {
    (async () => {
      try {
        const [dRes, pRes] = await Promise.all([
          fetch("/api/departments?includeInactive=false"),
          fetch("/api/positions?includeInactive=false"),
        ]);
        if (dRes.ok) setDepartments(await dRes.json());
        if (pRes.ok) setPositions(await pRes.json());
      } catch (e) {
        console.error("masters fetch error:", e);
      }
    })();
  }, []);

  const fetchEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (departmentFilter) params.set("departmentId", departmentFilter);
      if (positionFilter) params.set("positionId", positionFilter);
      if (includeInactive) params.set("includeInactive", "true");

      const res = await fetch(`/api/employees?${params}`);
      if (res.ok) setEmployees(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, departmentFilter, positionFilter, includeInactive]);

  useEffect(() => {
    const t = setTimeout(fetchEmployees, 300);
    return () => clearTimeout(t);
  }, [fetchEmployees]);

  // 폼 열 때 사용자 옵션 fetch
  // 신규: 매핑 안 된 사용자만
  // 수정: 매핑 안 된 사용자 + 현재 매핑된 사용자 1명 (자기 자신 옵션 유지)
  const loadUserOptions = useCallback(async (currentUserId: number | null) => {
    try {
      const res = await fetch("/api/users?excludeMapped=true");
      const available: UserOption[] = res.ok ? await res.json() : [];

      if (currentUserId !== null) {
        // 현재 매핑된 user 가져오기 (excludeMapped 결과엔 빠져 있음)
        const allRes = await fetch("/api/users");
        if (allRes.ok) {
          const all: UserOption[] = await allRes.json();
          const self = all.find((u) => u.id === currentUserId);
          if (self && !available.some((u) => u.id === self.id)) {
            available.push(self);
            available.sort((a, b) => a.name.localeCompare(b.name));
          }
        }
      }
      setAvailableUsers(available);
    } catch (e) {
      console.error("users fetch error:", e);
      setAvailableUsers([]);
    }
  }, []);

  const openCreate = () => {
    // 직급 기본값 = EMPLOYEE (positions 마스터에서 code='EMPLOYEE' 찾기)
    const employeePos = positions.find((p) => p.code === "EMPLOYEE");
    setEditTarget(null);
    setForm({
      ...EMPTY_FORM,
      hiredAt: today(),
      positionId: employeePos ? String(employeePos.id) : "",
    });
    setFormError("");
    setShowForm(true);
    loadUserOptions(null);
  };

  const openEdit = (e: Employee) => {
    setEditTarget(e);
    setForm({
      employeeNo: e.employeeNo ?? "",
      userId: e.userId === null ? "" : String(e.userId),
      name: e.name,
      email: e.email || "",
      departmentId: e.departmentId === null ? "" : String(e.departmentId),
      positionId: e.positionId === null ? "" : String(e.positionId),
      phone: e.phone || "",
      hiredAt: e.hiredAt ?? "",
      resignedAt: e.resignedAt || "",
      note: e.note || "",
    });
    setFormError("");
    setShowForm(true);
    loadUserOptions(e.userId);
  };

  const handleSave = async () => {
    if (form.userId === "") {
      setFormError(
        "이름·이메일은 SSO 사용자 마스터에서 가져옵니다. SSO 사용자를 선택하세요."
      );
      return;
    }
    if (!form.name.trim()) {
      setFormError("이름이 비어있습니다. SSO 사용자를 다시 선택하세요.");
      return;
    }
    if (form.positionId === "") {
      setFormError("직급은 필수입니다.");
      return;
    }
    // 퇴사일은 입사일이 있을 때만 비교
    if (form.resignedAt && form.hiredAt && form.resignedAt < form.hiredAt) {
      setFormError("퇴사일은 입사일 이후여야 합니다.");
      return;
    }

    setFormError("");
    setSaving(true);
    try {
      const url = editTarget
        ? `/api/employees?id=${editTarget.id}`
        : "/api/employees";
      const method = editTarget ? "PUT" : "POST";

      const payload = {
        employeeNo: form.employeeNo.trim() || null,
        userId: form.userId === "" ? null : Number(form.userId),
        name: form.name.trim(),
        email: form.email.trim() || null,
        departmentId:
          form.departmentId === "" ? null : Number(form.departmentId),
        positionId: form.positionId === "" ? null : Number(form.positionId),
        phone: form.phone.trim() || null,
        hiredAt: form.hiredAt || null,
        resignedAt: form.resignedAt || null,
        note: form.note.trim() || null,
      };

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "저장 실패");
        return;
      }
      showToast("✅ " + (editTarget ? "수정되었습니다" : "추가되었습니다"));
      setShowForm(false);
      fetchEmployees();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (e: Employee) => {
    try {
      const res = await fetch(`/api/employees?id=${e.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !e.isActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "변경 실패");
        return;
      }
      showToast(`✅ ${e.isActive ? "비활성" : "활성"} 처리됨`);
      fetchEmployees();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleDelete = async (e: Employee) => {
    const empNoLabel = e.employeeNo ? ` (${e.employeeNo})` : "";
    if (!confirm(`"${e.name}"${empNoLabel} 직원을 삭제하시겠습니까?`)) return;
    try {
      const res = await fetch(`/api/employees?id=${e.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "삭제 실패");
        return;
      }
      showToast("✅ 삭제되었습니다");
      fetchEmployees();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleExportCSV = () => {
    if (!employees || employees.length === 0) return;
    exportCSV(
      [
        "사번",
        "이름",
        "이메일",
        "부서코드",
        "부서명",
        "직급코드",
        "직급명",
        "전화",
        "입사일",
        "퇴사일",
        "SSOID",
        "활성",
        "메모",
      ],
      employees.map((e) => [
        e.employeeNo ?? "",
        e.name,
        e.email ?? "",
        e.departmentCode ?? "",
        e.departmentName ?? "",
        e.positionCode ?? "",
        e.positionName ?? "",
        e.phone ?? "",
        e.hiredAt ?? "",
        e.resignedAt ?? "",
        e.userId ?? "",
        e.isActive ? "Y" : "N",
        e.note ?? "",
      ]),
      `직원_${new Date().toISOString().split("T")[0]}.csv`
    );
  };

  // 현재 매핑된 SSO user 정보 표시용 (편집 폼에 자기 자신 옵션 표시 보장됨)
  const getMappedUser = (userId: number | null): UserOption | undefined => {
    if (userId === null) return undefined;
    return availableUsers.find((u) => u.id === userId);
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* 토스트 */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            직원 관리
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            직원 마스터 데이터 + SSO 매핑을 관리합니다
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            disabled={!employees || employees.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={15} />
            CSV
          </button>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 shadow-sm"
          >
            <Plus size={16} />
            직원 추가
          </button>
        </div>
      </div>

      {/* 등록 / 수정 폼 */}
      {showForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-blue-900">
              {editTarget ? "직원 수정" : "직원 추가"}
            </h2>
            <button
              onClick={() => setShowForm(false)}
              className="text-blue-400 hover:text-blue-700"
            >
              <X size={18} />
            </button>
          </div>

          {/* 포털 마스터 정책 안내 */}
          <div className="bg-white border border-blue-100 rounded-xl p-3 flex items-start gap-2.5">
            <Info size={16} className="text-blue-500 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-800 leading-relaxed">
              <span className="font-semibold">이름·이메일은 포털 SSO 사용자 마스터에서 관리</span>됩니다.
              직접 수정할 수 없으며, SSO 사용자 매핑을 변경하면 자동으로 동기화됩니다.
              <br />
              이름/이메일을 변경해야 하면{" "}
              <a
                href="https://vanam.synology.me"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-semibold"
              >
                VanaM 포털
              </a>
              에서 처리하세요.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 사번 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                사번
              </label>
              <input
                value={form.employeeNo}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    employeeNo: e.target.value.toUpperCase(),
                  }))
                }
                placeholder="예: V2026001 (선택)"
                maxLength={50}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 font-mono"
              />
            </div>

            {/* SSO 매핑 — 이름/이메일은 여기서 자동 채움 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                SSO 사용자 매핑 <span className="text-rose-500">*</span>
              </label>
              <select
                value={form.userId}
                onChange={(e) => {
                  const v = e.target.value;
                  const picked =
                    v === ""
                      ? null
                      : availableUsers.find((u) => String(u.id) === v) ?? null;
                  setForm((f) => ({
                    ...f,
                    userId: v,
                    // SSO 매핑 = 포털 사용자 마스터. 이름/이메일 자동 동기화.
                    name: picked ? picked.name : "",
                    email: picked?.email ?? "",
                  }));
                }}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">(SSO 사용자 선택)</option>
                {availableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email ?? `id: ${u.id}`})
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-gray-500 mt-1">
                포털 SSO 사용자를 선택하면 이름·이메일이 자동으로 채워집니다.
              </p>
            </div>

            {/* 이름 — read-only, SSO에서 자동 채움 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                이름 <span className="text-rose-500">*</span>
              </label>
              <input
                value={form.name}
                readOnly
                placeholder="(SSO 사용자 선택 시 자동 채움)"
                maxLength={100}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-gray-50 text-gray-700 outline-none cursor-not-allowed"
              />
            </div>

            {/* 이메일 — read-only, SSO에서 자동 채움 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                이메일 (포털 SSO)
              </label>
              <input
                type="email"
                value={form.email}
                readOnly
                placeholder="(SSO 사용자 선택 시 자동 채움)"
                maxLength={255}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-gray-50 text-gray-700 outline-none cursor-not-allowed"
              />
            </div>

            {/* 부서 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                부서
              </label>
              <select
                value={form.departmentId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, departmentId: e.target.value }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">(미지정)</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.code})
                  </option>
                ))}
              </select>
            </div>

            {/* 직급 = 권한 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                직급 (권한) <span className="text-rose-500">*</span>
              </label>
              <select
                value={form.positionId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, positionId: e.target.value }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              >
                {positions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-gray-500 mt-1">
                CEO=전체 조회 / ADMIN=자기 부서 (부서 미지정 시 전체) / EMPLOYEE=본인만
              </p>
            </div>

            {/* 전화 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                전화
              </label>
              <input
                value={form.phone}
                onChange={(e) =>
                  setForm((f) => ({ ...f, phone: e.target.value }))
                }
                placeholder="예: 010-1234-5678"
                maxLength={50}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            {/* 입사일 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                입사일
              </label>
              <DatePicker
                value={form.hiredAt}
                placeholder="입사일 선택"
                onChange={(val) => setForm((f) => ({ ...f, hiredAt: val }))}
              />
              <p className="text-[10px] text-gray-500 mt-1">
                선택 입력. 빈 값으로 두면 나중에 채울 수 있습니다.
              </p>
            </div>

            {/* 퇴사일 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                퇴사일
              </label>
              <DatePicker
                value={form.resignedAt}
                min={form.hiredAt || undefined}
                placeholder="퇴사일 선택"
                onChange={(val) => setForm((f) => ({ ...f, resignedAt: val }))}
              />
              <p className="text-[10px] text-gray-500 mt-1">
                입사일 이후여야 합니다. 빈 값 = 재직 중.
              </p>
            </div>

            {/* 메모 */}
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                메모
              </label>
              <textarea
                value={form.note}
                onChange={(e) =>
                  setForm((f) => ({ ...f, note: e.target.value }))
                }
                rows={2}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 resize-none"
              />
            </div>
          </div>

          {formError && (
            <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-xl">
              {formError}
            </p>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2.5 bg-blue-500 text-white rounded-xl text-sm font-semibold hover:bg-blue-600 disabled:opacity-60"
            >
              {saving ? "저장 중..." : editTarget ? "수정 저장" : "추가"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-5 py-2.5 bg-white border border-blue-200 text-blue-700 rounded-xl text-sm font-medium hover:bg-blue-50"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* 필터 */}
      <div className="bg-white rounded-2xl border border-gray-100 p-3 sm:p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* 부서 */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              부서
            </label>
            <select
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">전체</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          {/* 직급 */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              직급
            </label>
            <select
              value={positionFilter}
              onChange={(e) => setPositionFilter(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">전체</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* 검색 */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              검색
            </label>
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="text"
                placeholder="사번/이름/이메일"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer w-fit">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="rounded"
          />
          비활성 직원 포함
        </label>
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={24} className="animate-spin text-blue-500" />
          <span className="ml-2 text-sm text-gray-500">로딩 중...</span>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    사번
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    이름
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    부서
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    직급
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    입사일
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    SSO
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    이메일
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                    상태
                  </th>
                  <th className="text-center text-xs font-semibold text-gray-500 px-5 py-3">
                    작업
                  </th>
                </tr>
              </thead>
              <tbody>
                {employees.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-5 py-12 text-center text-sm text-gray-400"
                    >
                      등록된 직원이 없습니다
                    </td>
                  </tr>
                ) : (
                  employees.map((e) => {
                    const mappedUser = getMappedUser(e.userId);
                    return (
                      <tr
                        key={e.id}
                        className={`border-b border-gray-50 hover:bg-blue-50/30 group ${
                          !e.isActive ? "opacity-40" : ""
                        }`}
                      >
                        <td className="px-5 py-3 text-sm text-gray-900 font-mono">
                          {e.employeeNo || <span className="text-xs text-gray-300">-</span>}
                        </td>
                        <td className="px-5 py-3 text-sm font-semibold text-gray-900">
                          <div className="flex items-center gap-2">
                            <User size={14} className="text-gray-400" />
                            {e.name}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-500">
                          {e.departmentName || (
                            <span className="text-xs text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-500">
                          {e.positionName || (
                            <span className="text-xs text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-500 font-mono">
                          {e.hiredAt || <span className="text-xs text-gray-300">-</span>}
                        </td>
                        <td className="px-5 py-3 text-sm">
                          {e.userId !== null ? (
                            <span className="inline-flex items-center gap-1 text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                              <LinkIcon size={11} />
                              {mappedUser?.name ?? `id: ${e.userId}`}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-500 truncate max-w-xs">
                          {e.email || (
                            <span className="text-xs text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => handleToggleActive(e)}
                              className={`text-xs font-semibold px-2 py-0.5 rounded-full hover:opacity-80 ${
                                e.isActive
                                  ? "text-emerald-700 bg-emerald-50"
                                  : "text-gray-400 bg-gray-100"
                              }`}
                            >
                              {e.isActive ? "활성" : "비활성"}
                            </button>
                            {e.resignedAt && (
                              <span className="text-xs font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full">
                                퇴사
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => openEdit(e)}
                              className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                            >
                              <Edit size={15} />
                            </button>
                            <button
                              onClick={() => handleDelete(e)}
                              className="p-1.5 rounded-lg hover:bg-rose-100 text-gray-400 hover:text-rose-600"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* 모바일 */}
          <div className="md:hidden divide-y divide-gray-50">
            {employees.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                등록된 직원이 없습니다
              </div>
            ) : (
              employees.map((e) => (
                <div
                  key={e.id}
                  className={`px-4 py-3 space-y-1 ${
                    !e.isActive ? "opacity-40" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <User size={14} className="text-gray-400 shrink-0" />
                      <span className="text-sm font-semibold text-gray-900 truncate">
                        {e.name}
                      </span>
                      <span className="text-xs text-gray-400 font-mono shrink-0">
                        {e.employeeNo || "-"}
                      </span>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => openEdit(e)}
                        className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600"
                      >
                        <Edit size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(e)}
                        className="p-1.5 rounded-lg hover:bg-rose-50 text-gray-400 hover:text-rose-600"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400">
                    {e.departmentName ?? "(부서 없음)"} ·{" "}
                    {e.positionName ?? "(직급 없음)"}
                    {e.hiredAt && ` · 입사 ${e.hiredAt}`}
                    {e.resignedAt && ` · 퇴사 ${e.resignedAt}`}
                  </p>
                  {e.userId !== null && (
                    <p className="text-[10px] text-blue-600">
                      <LinkIcon
                        size={10}
                        className="inline mr-1 -translate-y-px"
                      />
                      SSO 매핑됨
                    </p>
                  )}
                </div>
              ))
            )}
          </div>

          {employees.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
              <p className="text-xs font-semibold text-gray-700">
                총 {employees.length}건
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
