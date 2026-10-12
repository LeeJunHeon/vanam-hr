"use client";

import { useLayoutEffect, useRef, useState } from "react";

// 내용 높이에 맞춰 늘어나는 textarea — 칸 안 스크롤바·크기 조절 손잡이 없음.
// CSS field-sizing 은 Safari 지원이 불확실해 쓰지 않고 scrollHeight 로 계산한다.
// minRows=1 이면 빈 칸일 때 같은 줄의 input·select 와 높이가 같다 (같은 padding·border·line-height).
// singleLine 이면 한 줄 항목 — 줄바꿈(엔터·붙여넣기)을 공백으로 바꾼다. 한글 조합이 깨지지 않게
// keydown 이 아니라 onChange 에서 처리한다.
// 글자 수가 최대의 80% 이상이면 아래에 "1,650 / 2,000" 을, 최대면 빨간색 안내를 보여 준다.

const COUNTER_FROM = 0.8;

export default function AutoTextarea({
  value,
  onChange,
  maxLength,
  minRows = 1,
  singleLine = false,
  placeholder,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  minRows?: number;
  singleLine?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastWidth = useRef(0);
  // 줄바꿈을 공백으로 바꾼 뒤 커서 위치 복원용 (같은 길이로 바꾸므로 위치 그대로)
  const pendingCaret = useRef<number | null>(null);
  // 붙여넣기가 최대 글자 수를 넘었는지 — 다음 onChange 에서 안내로 반영
  const pasteOverflow = useRef(false);
  const [pasteTruncated, setPasteTruncated] = useState(false);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight 는 border 를 빼므로 더해 준다 (border-box)
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  };

  // 값이 바뀔 때 (입력·붙여넣기·불러오기)
  useLayoutEffect(() => {
    resize();
    const el = ref.current;
    if (el && pendingCaret.current != null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  // 칸 너비가 바뀔 때 (창 너비 변경·표 열 너비 변경) — 높이 변경으로 다시 불리는 것은 너비 비교로 거른다
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    lastWidth.current = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === lastWidth.current) return;
      lastWidth.current = el.offsetWidth;
      resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    let next = e.target.value;
    if (singleLine && /[\r\n]/.test(next)) {
      pendingCaret.current = e.target.selectionStart;
      next = next.replace(/\r\n|\r|\n/g, " ");
    }
    setPasteTruncated(pasteOverflow.current);
    pasteOverflow.current = false;
    onChange(next);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const pasted = e.clipboardData.getData("text").replace(/\r\n/g, "\n");
    const kept = el.value.length - (el.selectionEnd - el.selectionStart);
    pasteOverflow.current = kept + pasted.length > maxLength;
  };

  const len = value.length;
  const atMax = len >= maxLength;
  const showCounter = pasteTruncated || len >= maxLength * COUNTER_FROM;

  return (
    <div>
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onPaste={handlePaste}
        placeholder={placeholder}
        maxLength={maxLength}
        rows={minRows}
        className={`block resize-none overflow-hidden ${className}`}
      />
      {showCounter && (
        <p className={`mt-1 text-[11px] ${atMax || pasteTruncated ? "text-rose-600" : "text-gray-400"}`}>
          {pasteTruncated
            ? "붙여넣은 내용 중 최대 글자 수를 넘는 부분은 잘렸습니다"
            : `${len.toLocaleString("ko-KR")} / ${maxLength.toLocaleString("ko-KR")}${atMax ? " · 최대 글자 수입니다" : ""}`}
        </p>
      )}
    </div>
  );
}
