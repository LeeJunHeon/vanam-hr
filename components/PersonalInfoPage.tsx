"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Search, Save, Trash2, Eye, EyeOff, IdCard, Plus } from "lucide-react";

interface EmpListItem {
  employeeId: number;
  employeeNo: string | null;
  name: string;
  departmentName: string | null;
  positionName: string | null;
  hasInfo: boolean;
}

interface PersonalDetail {
  employeeId: number;
  employeeNo: string | null;
  name: string;
  positionName: string | null;
  departmentName: string | null;
  hiredAt: string | null;
  phone: string | null;
  email: string | null;
  hrName: string | null;
  hrPosition: string | null;
  hrDepartment: string | null;
  hrPhone: string | null;
  researcherNumber: string | null;
  university: string | null;
  finalDegree: string | null;
  major: string | null;
  graduationYearmonth: string | null;
  degreeNumber: string | null;
  residentNumber: string | null;
  address: string | null;
  bankName: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  hasInfo: boolean;
}

// 마스킹: 앞 절반만 보이고 뒤는 ● 처리 (간단)
function maskValue(v: string | null): string {
  if (!v) return "-";
  const len = v.length;
  if (len <= 2) return "●".repeat(len);
  const visible = Math.ceil(len / 3);
  return v.slice(0, visible) + "●".repeat(len - visible);
}

export default function PersonalInfoPage() {
  const [list, setList] = useState<EmpListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PersonalDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<PersonalDetail>>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  // 마스킹 토글 (주민번호/계좌 각각)
  const [showResident, setShowResident] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  // 인사 전용 직원 추가 모달
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [adding, setAdding] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  const fetchList = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await fetch("/api/personal-info");
      if (res.ok) setList(await res.json());
    } catch (e) {
      console.error("personal-info list error:", e);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const fetchDetail = useCallback(async (employeeId: number) => {
    setDetailLoading(true);
    setEditing(false);
    setShowResident(false);
    setShowAccount(false);
    try {
      const res = await fetch(`/api/personal-info/${employeeId}`);
      if (res.ok) {
        const d = await res.json();
        setDetail(d);
        setForm(d);
      }
    } catch (e) {
      console.error("personal-info detail error:", e);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const selectEmployee = (employeeId: number) => {
    setSelectedId(employeeId);
    fetchDetail(employeeId);
  };

  const handleSave = async () => {
    if (selectedId == null) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/personal-info/${selectedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        showToast("저장되었습니다.");
        setEditing(false);
        await fetchDetail(selectedId);
        await fetchList(); // hasInfo 갱신
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error ?? "저장 실패");
      }
    } catch {
      showToast("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const handleAddPerson = async () => {
    const nm = addName.trim();
    if (!nm) { showToast("성명을 입력하세요."); return; }
    setAdding(true);
    try {
      const res = await fetch("/api/personal-info/persons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nm }),
      });
      if (res.ok) {
        const d = await res.json();
        showToast("직원이 추가되었습니다.");
        setAddOpen(false);
        setAddName("");
        await fetchList();
        if (d.employeeId) selectEmployee(d.employeeId);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error ?? "추가 실패");
      }
    } catch {
      showToast("네트워크 오류");
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async () => {
    if (selectedId == null) return;
    if (!confirm("이 직원의 정보를 삭제하시겠습니까?\n(인사정보 카드에서 추가한 인사 전용 직원이면 직원 전체가, 근태 직원이면 추가 정보만 삭제됩니다.)")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/personal-info/${selectedId}`, { method: "DELETE" });
      if (res.ok) {
        showToast("삭제되었습니다.");
        await fetchDetail(selectedId);
        await fetchList();
      } else {
        showToast("삭제 실패");
      }
    } catch {
      showToast("네트워크 오류");
    } finally {
      setSaving(false);
    }
  };

  const filteredList = list.filter((e) =>
    !search || e.name.includes(search) || (e.employeeNo ?? "").includes(search)
  );

  // 읽기 전용 필드 표시
  const field = (label: string, value: string | null | undefined) => (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-sm text-gray-900">{value || "-"}</div>
    </div>
  );

  // 마스킹 필드 (값 + 토글 버튼)
  const maskedField = (
    label: string,
    value: string | null | undefined,
    show: boolean,
    setShow: (v: boolean) => void
  ) => (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-900 font-mono">
          {value ? (show ? value : maskValue(value)) : "-"}
        </span>
        {value && (
          <button
            onClick={() => setShow(!show)}
            className="text-gray-400 hover:text-blue-600"
            title={show ? "숨기기" : "보기"}
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
    </div>
  );

  // 입력 필드 (수정 모드)
  const inputField = (label: string, key: keyof PersonalDetail, placeholder?: string) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="text"
        value={(form[key] as string) ?? ""}
        onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
        placeholder={placeholder}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
      />
    </div>
  );

  return (
    <div className="p-4 sm:p-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg">
          {toast}
        </div>
      )}

      <div className="mb-4">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
          <IdCard size={22} className="text-blue-600" />
          인사정보 카드
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          직원의 인사 기준 정보·학력·계좌 등을 관리합니다 (제한된 권한자만 접근)
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-4">
        {/* 좌측 — 직원 목록 */}
        <div className="lg:w-72 shrink-0 bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="p-3 border-b border-gray-100 space-y-2">
            <button
              onClick={() => { setAddName(""); setAddOpen(true); }}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700"
            >
              <Plus size={15} />
              직원 추가
            </button>
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="이름/사번 검색"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
              />
            </div>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {listLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="animate-spin text-gray-400" size={24} />
              </div>
            ) : (
              filteredList.map((e) => (
                <button
                  key={e.employeeId}
                  onClick={() => selectEmployee(e.employeeId)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                    selectedId === e.employeeId ? "bg-blue-50" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">{e.name}</span>
                    {e.hasInfo && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="정보 입력됨" />}
                  </div>
                  <div className="text-xs text-gray-500">
                    {e.departmentName ?? "-"} · {e.positionName ?? "-"}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* 우측 — 상세 */}
        <div className="flex-1 bg-white rounded-2xl border border-gray-100 p-5 min-h-[400px]">
          {selectedId == null ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm py-20">
              왼쪽에서 직원을 선택하세요.
            </div>
          ) : detailLoading ? (
            <div className="flex justify-center py-20">
              <Loader2 className="animate-spin text-gray-400" size={28} />
            </div>
          ) : detail ? (
            <div className="space-y-5">
              {/* 헤더 + 액션 */}
              <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">{detail.hrName || detail.name}</h2>
                  <p className="text-xs text-gray-500">
                    {(detail.hrPosition || detail.positionName) ?? "-"} · {(detail.hrDepartment || detail.departmentName) ?? "-"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {!editing ? (
                    <>
                      <button
                        onClick={() => { setForm(detail); setEditing(true); }}
                        className="px-3 py-2 text-sm font-medium text-blue-700 bg-blue-50 rounded-xl hover:bg-blue-100"
                      >
                        수정
                      </button>
                      {detail.hasInfo && (
                        <button
                          onClick={handleDelete}
                          disabled={saving}
                          className="px-3 py-2 text-sm font-medium text-rose-600 bg-rose-50 rounded-xl hover:bg-rose-100 disabled:opacity-50"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50"
                      >
                        {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                        저장
                      </button>
                      <button
                        onClick={() => { setEditing(false); setForm(detail); }}
                        className="px-3 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200"
                      >
                        취소
                      </button>
                    </>
                  )}
                </div>
              </div>

              {!editing ? (
                // ── 조회 모드 ──
                <div className="space-y-5">
                  {/* 회사 */}
                  <section>
                    <h3 className="text-xs font-bold text-gray-700 mb-2">회사</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {field("사번", detail.employeeNo)}
                      {field("직책", detail.hrPosition)}
                      {field("소속", detail.hrDepartment)}
                      {field("입사일", detail.hiredAt)}
                      {field("국가연구자 번호", detail.researcherNumber)}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2">
                      근태 시스템 등록명: {detail.name} · {detail.positionName ?? "-"} · {detail.departmentName ?? "-"}
                    </p>
                  </section>

                  {/* 졸업 대학 정보 */}
                  <section>
                    <h3 className="text-xs font-bold text-gray-700 mb-2">졸업 대학 정보</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {field("대학교", detail.university)}
                      {field("최종 학위", detail.finalDegree)}
                      {field("전공", detail.major)}
                      {field("졸업년월", detail.graduationYearmonth)}
                      {field("학위등록번호", detail.degreeNumber)}
                    </div>
                  </section>

                  {/* 개인 정보 */}
                  <section>
                    <h3 className="text-xs font-bold text-gray-700 mb-2">개인 정보</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {maskedField("주민번호", detail.residentNumber, showResident, setShowResident)}
                      {field("연락처", detail.hrPhone)}
                      {field("주소", detail.address)}
                      {field("이메일", detail.email)}
                    </div>
                  </section>

                  {/* 급여 통장 */}
                  <section>
                    <h3 className="text-xs font-bold text-gray-700 mb-2">급여 통장</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {field("은행", detail.bankName)}
                      {maskedField("계좌", detail.accountNumber, showAccount, setShowAccount)}
                      {field("예금주", detail.accountHolder)}
                    </div>
                  </section>
                </div>
              ) : (
                // ── 수정 모드 ──
                <div className="space-y-5">
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-xs text-amber-800">
                    사번·이메일·입사일은 직원 관리와 공유됩니다(여기서 수정하면 직원 관리에도 반영). 성명/직책/소속/연락처는 인사정보 카드 전용입니다.
                  </div>

                  {/* 성명 (맨 위) */}
                  <section>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {inputField("성명(한글)", "hrName")}
                    </div>
                  </section>

                  {/* 회사 */}
                  <section>
                    <h3 className="text-xs font-bold text-gray-700 mb-2">회사</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {inputField("사번", "employeeNo")}
                      {inputField("직책", "hrPosition")}
                      {inputField("소속", "hrDepartment")}
                      {inputField("입사일", "hiredAt", "예: 2024-01-15")}
                      {inputField("국가연구자 번호", "researcherNumber")}
                    </div>
                  </section>

                  {/* 졸업 대학 정보 */}
                  <section>
                    <h3 className="text-xs font-bold text-gray-700 mb-2">졸업 대학 정보</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {inputField("대학교", "university")}
                      {inputField("최종 학위", "finalDegree")}
                      {inputField("전공", "major")}
                      {inputField("졸업년월", "graduationYearmonth", "예: 2020-02")}
                      {inputField("학위등록번호", "degreeNumber")}
                    </div>
                  </section>

                  {/* 개인 정보 */}
                  <section>
                    <h3 className="text-xs font-bold text-gray-700 mb-2">개인 정보</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {inputField("주민번호", "residentNumber", "예: 000000-0000000")}
                      {inputField("연락처", "hrPhone")}
                      {inputField("주소", "address")}
                      {inputField("이메일", "email")}
                    </div>
                  </section>

                  {/* 급여 통장 */}
                  <section>
                    <h3 className="text-xs font-bold text-gray-700 mb-2">급여 통장</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {inputField("은행", "bankName")}
                      {inputField("계좌", "accountNumber")}
                      {inputField("예금주", "accountHolder")}
                    </div>
                  </section>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center text-gray-400 py-20 text-sm">정보를 불러올 수 없습니다.</div>
          )}
        </div>
      </div>

      {/* 직원 추가 모달 */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-5">
            <h3 className="text-base font-bold text-gray-900 mb-1">인사 전용 직원 추가</h3>
            <p className="text-xs text-gray-500 mb-4">
              근태 시스템에는 표시되지 않는 인사정보 카드 전용 직원입니다. 나머지 정보는 추가 후 상세에서 편집하세요.
            </p>
            <label className="block text-xs font-medium text-gray-600 mb-1">성명(한글)</label>
            <input
              type="text"
              autoFocus
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAddPerson(); }}
              placeholder="예: 홍길동"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => { setAddOpen(false); setAddName(""); }}
                className="px-3 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-xl hover:bg-gray-200"
              >
                취소
              </button>
              <button
                onClick={handleAddPerson}
                disabled={adding}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50"
              >
                {adding ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                추가
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
