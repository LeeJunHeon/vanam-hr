"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

interface Props {
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  size?: "sm" | "md"; // sm: 캘린더 헤더용 / md: 페이지 헤더용 (기본)
  title?: string;
  className?: string;
}

// 공용 Excel 다운로드 버튼. onClick을 await하는 동안 disabled + 스피너.
export default function ExcelButton({
  onClick,
  disabled,
  size = "md",
  title,
  className = "",
}: Props) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await onClick();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sizeCls = size === "sm" ? "px-3 py-1.5" : "px-3 py-2";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || busy}
      title={title}
      className={`flex items-center gap-1.5 text-sm font-medium bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 hover:text-emerald-700 hover:border-emerald-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${sizeCls} ${className}`}
    >
      {busy ? (
        <Loader2 size={15} className="animate-spin" />
      ) : (
        <Download size={15} />
      )}
      {busy ? "생성 중" : "Excel"}
    </button>
  );
}
