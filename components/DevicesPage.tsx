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
  Smartphone,
  Wifi,
} from "lucide-react";
import { exportCSV } from "@/lib/csvUtils";
import { normalizeMacAddress, formatMacAddress } from "@/lib/macAddress";

interface Device {
  id: number;
  employeeId: number;
  employeeNo: string;
  employeeName: string;
  macAddress: string; // 정규화된 lowercase 12자리
  hostname: string | null;
  ipAddress: string | null;
  deviceType: string | null;
  label: string | null;
  isActive: boolean;
  lastSeenAt: string | null; // ISO
  registeredAt: string; // ISO
}

interface EmployeeOption {
  id: number;
  employeeNo: string;
  name: string;
}

interface TypeLookup {
  id: number;
  code: string;
  label: string;
}

const EMPTY_FORM = {
  employeeId: "" as "" | string,
  macAddress: "",
  hostname: "",
  ipAddress: "",
  deviceType: "",
  label: "",
};

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "기록 없음";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "방금";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [includeInactive, setIncludeInactive] = useState(false);

  // 외부 참조
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [typeLookups, setTypeLookups] = useState<TypeLookup[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Device | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  // 마스터 1회 로드 (employees / device_type lookups)
  useEffect(() => {
    (async () => {
      try {
        const [eRes, lRes] = await Promise.all([
          fetch("/api/employees?includeInactive=false"),
          fetch("/api/lookups?category=device_type&includeInactive=false"),
        ]);
        if (eRes.ok) {
          const data = await eRes.json();
          setEmployees(
            data.map((d: any) => ({
              id: d.id,
              employeeNo: d.employeeNo,
              name: d.name,
            }))
          );
        }
        if (lRes.ok) setTypeLookups(await lRes.json());
      } catch (e) {
        console.error("masters fetch error:", e);
      }
    })();
  }, []);

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (employeeFilter) params.set("employeeId", employeeFilter);
      if (typeFilter) params.set("deviceType", typeFilter);
      if (includeInactive) params.set("includeInactive", "true");

      const res = await fetch(`/api/devices?${params}`);
      if (res.ok) setDevices(await res.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, employeeFilter, typeFilter, includeInactive]);

  useEffect(() => {
    const t = setTimeout(fetchDevices, 300);
    return () => clearTimeout(t);
  }, [fetchDevices]);

  const getTypeLabel = (code: string | null): string => {
    if (!code) return "-";
    const lookup = typeLookups.find((l) => l.code === code);
    return lookup ? lookup.label : code;
  };

  const openCreate = () => {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setShowForm(true);
  };

  const openEdit = (d: Device) => {
    setEditTarget(d);
    setForm({
      employeeId: String(d.employeeId),
      macAddress: formatMacAddress(d.macAddress),
      hostname: d.hostname || "",
      ipAddress: d.ipAddress || "",
      deviceType: d.deviceType || "",
      label: d.label || "",
    });
    setFormError("");
    setShowForm(true);
  };

  // MAC 입력 blur 시 자동 포맷
  const onMacBlur = () => {
    const normalized = normalizeMacAddress(form.macAddress);
    if (normalized) {
      setForm((f) => ({ ...f, macAddress: formatMacAddress(normalized) }));
    }
  };

  const handleSave = async () => {
    if (!form.employeeId || !form.macAddress.trim()) {
      setFormError("직원, MAC 주소는 필수입니다.");
      return;
    }
    const normalized = normalizeMacAddress(form.macAddress);
    if (!normalized) {
      setFormError("MAC 주소 형식이 올바르지 않습니다 (16진수 12자리).");
      return;
    }

    setFormError("");
    setSaving(true);
    try {
      const url = editTarget
        ? `/api/devices?id=${editTarget.id}`
        : "/api/devices";
      const method = editTarget ? "PUT" : "POST";

      const payload = {
        employeeId: Number(form.employeeId),
        macAddress: normalized, // 정규화된 소문자 12자리
        hostname: form.hostname.trim() || null,
        ipAddress: form.ipAddress.trim() || null,
        deviceType: form.deviceType.trim() || null,
        label: form.label.trim() || null,
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
      fetchDevices();
    } catch {
      setFormError("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (d: Device) => {
    try {
      const res = await fetch(`/api/devices?id=${d.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !d.isActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "변경 실패");
        return;
      }
      showToast(`✅ ${d.isActive ? "비활성" : "활성"} 처리됨`);
      fetchDevices();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleDelete = async (d: Device) => {
    if (
      !confirm(
        `${d.employeeName} (${d.employeeNo})의 디바이스 ${formatMacAddress(
          d.macAddress
        )}를 삭제하시겠습니까?`
      )
    )
      return;
    try {
      const res = await fetch(`/api/devices?id=${d.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "삭제 실패");
        return;
      }
      showToast("✅ 삭제되었습니다");
      fetchDevices();
    } catch {
      alert("네트워크 오류");
    }
  };

  const handleExportCSV = () => {
    if (!devices || devices.length === 0) return;
    exportCSV(
      [
        "직원사번",
        "직원명",
        "MAC",
        "유형",
        "호스트명",
        "라벨",
        "IP",
        "마지막접속",
        "활성",
        "등록일",
      ],
      devices.map((d) => [
        d.employeeNo,
        d.employeeName,
        formatMacAddress(d.macAddress),
        getTypeLabel(d.deviceType),
        d.hostname ?? "",
        d.label ?? "",
        d.ipAddress ?? "",
        d.lastSeenAt
          ? new Date(d.lastSeenAt).toLocaleString("ko-KR")
          : "",
        d.isActive ? "Y" : "N",
        new Date(d.registeredAt).toLocaleString("ko-KR"),
      ]),
      `디바이스_${new Date().toISOString().split("T")[0]}.csv`
    );
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
            디바이스 관리
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            WiFi 폴링 대상 디바이스(MAC 주소) + ipTIME 호스트명 매핑
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            disabled={!devices || devices.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={15} />
            CSV
          </button>
          <button
            onClick={openCreate}
            disabled={employees.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-blue-500 rounded-xl hover:bg-blue-600 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              employees.length === 0 ? "먼저 직원을 등록하세요" : ""
            }
          >
            <Plus size={16} />
            디바이스 추가
          </button>
        </div>
      </div>

      {/* 동의서 안내 배너 */}
      <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-sm text-amber-800">
        <strong>안내:</strong> MAC 주소 수집은 직원 동의서 확보 후 진행해야
        합니다 (노동법). 등록 전 별도 동의 절차를 거치세요.
      </div>

      {/* 등록 / 수정 폼 */}
      {showForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-blue-900">
              {editTarget ? "디바이스 수정" : "디바이스 추가"}
            </h2>
            <button
              onClick={() => setShowForm(false)}
              className="text-blue-400 hover:text-blue-700"
            >
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 직원 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                직원 <span className="text-rose-500">*</span>
              </label>
              <select
                value={form.employeeId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, employeeId: e.target.value }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">(선택)</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.employeeNo})
                  </option>
                ))}
              </select>
            </div>

            {/* MAC */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                MAC 주소 <span className="text-rose-500">*</span>
              </label>
              <input
                value={form.macAddress}
                onChange={(e) =>
                  setForm((f) => ({ ...f, macAddress: e.target.value }))
                }
                onBlur={onMacBlur}
                placeholder="예: AA:BB:CC:DD:EE:FF (콜론/하이픈 자유)"
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 font-mono"
              />
              <p className="text-[10px] text-gray-500 mt-1">
                입력 후 포커스 해제 시 자동 포맷됩니다
              </p>
            </div>

            {/* 디바이스 유형 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                디바이스 유형
              </label>
              <select
                value={form.deviceType}
                onChange={(e) =>
                  setForm((f) => ({ ...f, deviceType: e.target.value }))
                }
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">(선택)</option>
                {typeLookups.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 라벨 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                라벨
              </label>
              <input
                value={form.label}
                onChange={(e) =>
                  setForm((f) => ({ ...f, label: e.target.value }))
                }
                placeholder="예: 내 폰, 업무폰"
                maxLength={100}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            {/* 호스트명 */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                호스트명 (ipTIME 표시명)
              </label>
              <input
                value={form.hostname}
                onChange={(e) =>
                  setForm((f) => ({ ...f, hostname: e.target.value }))
                }
                placeholder="예: iPhone-of-Hong"
                maxLength={255}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>

            {/* IP */}
            <div>
              <label className="block text-xs font-semibold text-blue-700 mb-1">
                IP 주소
              </label>
              <input
                value={form.ipAddress}
                onChange={(e) =>
                  setForm((f) => ({ ...f, ipAddress: e.target.value }))
                }
                placeholder="예: 192.168.0.123"
                maxLength={45}
                className="w-full px-3 py-2.5 border border-blue-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-400 font-mono"
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
          {/* 직원 */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              직원
            </label>
            <select
              value={employeeFilter}
              onChange={(e) => setEmployeeFilter(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">전체</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.employeeNo})
                </option>
              ))}
            </select>
          </div>

          {/* 유형 */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              유형
            </label>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">전체</option>
              {typeLookups.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
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
                placeholder="MAC/호스트명/라벨/직원명"
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
          비활성 디바이스 포함
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
                    직원
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    MAC
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    유형
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    호스트명
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    라벨
                  </th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-5 py-3">
                    마지막 접속
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
                {devices.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-5 py-12 text-center text-sm text-gray-400"
                    >
                      등록된 디바이스가 없습니다
                    </td>
                  </tr>
                ) : (
                  devices.map((d) => (
                    <tr
                      key={d.id}
                      className={`border-b border-gray-50 hover:bg-blue-50/30 group ${
                        !d.isActive ? "opacity-40" : ""
                      }`}
                    >
                      <td className="px-5 py-3 text-sm">
                        <div className="font-semibold text-gray-900">
                          {d.employeeName}
                        </div>
                        <div className="text-xs text-gray-400 font-mono">
                          {d.employeeNo}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-900 font-mono">
                        <div className="flex items-center gap-1.5">
                          <Smartphone size={14} className="text-gray-400" />
                          {formatMacAddress(d.macAddress)}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">
                        {d.deviceType ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                            {getTypeLabel(d.deviceType)}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500 max-w-xs truncate">
                        {d.hostname || (
                          <span className="text-xs text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500 max-w-xs truncate">
                        {d.label || (
                          <span className="text-xs text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm">
                        {d.lastSeenAt ? (
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                            <Wifi size={11} />
                            {formatRelativeTime(d.lastSeenAt)}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300">
                            기록 없음
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-center">
                        <button
                          onClick={() => handleToggleActive(d)}
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full hover:opacity-80 ${
                            d.isActive
                              ? "text-emerald-700 bg-emerald-50"
                              : "text-gray-400 bg-gray-100"
                          }`}
                        >
                          {d.isActive ? "활성" : "비활성"}
                        </button>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEdit(d)}
                            className="p-1.5 rounded-lg hover:bg-blue-100 text-gray-400 hover:text-blue-600"
                          >
                            <Edit size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(d)}
                            className="p-1.5 rounded-lg hover:bg-rose-100 text-gray-400 hover:text-rose-600"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* 모바일 */}
          <div className="md:hidden divide-y divide-gray-50">
            {devices.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-gray-400">
                등록된 디바이스가 없습니다
              </div>
            ) : (
              devices.map((d) => (
                <div
                  key={d.id}
                  className={`px-4 py-3 space-y-1 ${
                    !d.isActive ? "opacity-40" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <Smartphone
                        size={14}
                        className="text-gray-400 shrink-0"
                      />
                      <span className="text-sm font-semibold text-gray-900 truncate">
                        {d.employeeName}
                      </span>
                      <span className="text-xs text-gray-400 font-mono shrink-0">
                        {d.employeeNo}
                      </span>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => openEdit(d)}
                        className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600"
                      >
                        <Edit size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(d)}
                        className="p-1.5 rounded-lg hover:bg-rose-50 text-gray-400 hover:text-rose-600"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 font-mono">
                    {formatMacAddress(d.macAddress)}
                  </p>
                  <p className="text-xs text-gray-400">
                    {getTypeLabel(d.deviceType)} ·{" "}
                    {d.lastSeenAt
                      ? formatRelativeTime(d.lastSeenAt)
                      : "기록 없음"}
                  </p>
                </div>
              ))
            )}
          </div>

          {devices.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
              <p className="text-xs font-semibold text-gray-700">
                총 {devices.length}건
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
