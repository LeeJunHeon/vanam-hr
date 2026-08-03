"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

export const PAGE_SIZES = [10, 20, 50] as const;

/** 표시할 페이지 번호 목록 — 7개 초과면 현재 페이지 주변만 남기고 …로 축약 */
function pageItems(page: number, totalPages: number): (number | "…")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const items: (number | "…")[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) items.push("…");
  for (let p = start; p <= end; p++) items.push(p);
  if (end < totalPages - 1) items.push("…");
  items.push(totalPages);
  return items;
}

export default function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // 한 페이지에 다 들어가면 번호 버튼은 숨기고 건수/개수 select만 남긴다
  const showPages = total > pageSize;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-2">
      <span className="text-xs text-gray-500 shrink-0">총 {total}건</span>

      {showPages && (
        <div className="flex items-center gap-1 order-last sm:order-none w-full sm:w-auto justify-center">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="이전 페이지"
          >
            <ChevronLeft size={15} />
          </button>

          {pageItems(page, totalPages).map((it, i) =>
            it === "…" ? (
              <span key={`gap-${i}`} className="px-1.5 text-xs text-gray-400">
                …
              </span>
            ) : (
              <button
                key={it}
                onClick={() => onPageChange(it)}
                aria-current={it === page ? "page" : undefined}
                className={`min-w-[30px] px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  it === page
                    ? "bg-blue-500 text-white"
                    : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {it}
              </button>
            )
          )}

          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="다음 페이지"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      )}

      <select
        value={pageSize}
        onChange={(e) => onPageSizeChange(Number(e.target.value))}
        className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-xl bg-white shrink-0"
        aria-label="페이지당 개수"
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}개씩
          </option>
        ))}
      </select>
    </div>
  );
}
