// 코드에 기본값이 있는 정책 키 — 정책 설정 화면에 행이 없어도 기본값으로 보이고, 처음 저장할 때 행을 만든다
// (알림 채널 키 notify_* 를 PUT 이 만드는 것과 같은 방식). 서버·클라이언트 공용 순수 모듈.
import {
  DEFAULT_HALF_DAY_SPLIT_MINUTES,
  HALF_DAY_SPLIT_POLICY_KEY,
  HALF_DAY_SPLIT_STEP,
  formatSplit,
  parseSplitMinutes,
} from "@/lib/half-day";

export interface CodeDefaultPolicy {
  key: string;
  /** 화면 이름 */
  label: string;
  defaultValue: string;
  description: string;
  /** 값 표시 — 240 → "240분 (4시간)" */
  display: (value: string) => string;
  /** 저장 전 검증 — 오류 문구 또는 null */
  validate: (value: string) => string | null;
}

export const CODE_DEFAULT_POLICIES: CodeDefaultPolicy[] = [
  {
    key: HALF_DAY_SPLIT_POLICY_KEY,
    label: "오전반차 시간 기본값",
    defaultValue: String(DEFAULT_HALF_DAY_SPLIT_MINUTES),
    description:
      "시프트 시작부터 이 시간까지가 오전반차, 나머지는 오후반차입니다. 시프트 패턴에서 따로 정하지 않으면 이 값을 씁니다.",
    display: (v) => {
      const n = parseSplitMinutes(v);
      return n ? formatSplit(n) : v;
    },
    validate: (v) => {
      const n = Number(v);
      if (!/^\d+$/.test(v) || !Number.isInteger(n) || n <= 0) return "오전반차 시간은 0보다 큰 분(정수)으로 입력하세요. 예: 240 (= 4시간)";
      if (n % HALF_DAY_SPLIT_STEP !== 0) return `오전반차 시간은 ${HALF_DAY_SPLIT_STEP}분 단위로 입력하세요. 예: 240, 270`;
      if (n >= 24 * 60) return "오전반차 시간은 24시간(1440분)보다 짧아야 합니다.";
      return null;
    },
  },
];

export function findCodeDefaultPolicy(key: string): CodeDefaultPolicy | undefined {
  return CODE_DEFAULT_POLICIES.find((p) => p.key === key);
}
