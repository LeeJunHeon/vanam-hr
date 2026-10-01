// npm run parity — 웹(TS)과 aggregator·syncer(Python)의 규칙 결과를 같은 케이스(cases.json)로 비교한다.
// TS: node --import tsx tests/parity/run-ts.ts / Python: tests/parity/run_py.py (PYTHON 환경변수로 실행 파일 지정 가능)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf-8"));

function runJson(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return { error: r.error?.message || r.stderr || `exit ${r.status}` };
  try {
    return { data: JSON.parse(r.stdout) };
  } catch {
    return { error: `JSON 아님: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 500)}` };
  }
}

const ts = runJson(process.execPath, ["--import", "tsx", join(here, "run-ts.ts")]);
if (ts.error) {
  console.error("TS 실행 실패:\n" + ts.error);
  process.exit(2);
}

let py = { error: "python 을 찾지 못함" };
for (const cand of [process.env.PYTHON, "python3", "python"].filter(Boolean)) {
  const r = runJson(cand, [join(here, "run_py.py")]);
  if (!r.error) {
    py = r;
    break;
  }
  py = r;
}
if (py.error) {
  console.error("Python 실행 실패:\n" + py.error);
  process.exit(2);
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let fail = 0;
let total = 0;

for (const section of ["eval_keys", "all_day", "window", "judge_day", "shift_point", "research_meeting", "work_date"]) {
  const list = cases[section];
  list.forEach((c, i) => {
    total++;
    const t = ts.data[section][i];
    const p = py.data[section][i];
    const label = `${section}[${i}]${c.name ? " " + c.name : ""}`;
    if (!eq(t, p)) {
      fail++;
      console.log(`✗ ${label} — TS ${JSON.stringify(t)} ≠ Python ${JSON.stringify(p)}`);
      return;
    }
    if (c.expect !== undefined) {
      const exp = section === "window" && c.expect.full_cover ? { full_cover: true } : c.expect;
      if (!eq(t, exp)) {
        fail++;
        console.log(`✗ ${label} — 결과 ${JSON.stringify(t)} ≠ 기대 ${JSON.stringify(exp)}`);
      }
    }
  });
}

// 상수 목록 — 웹·aggregator·syncer 세 곳이 같아야 한다
const web = ts.data.constants.web;
const agg = py.data.constants.aggregator;
const syn = py.data.constants.syncer;
const sameSet = (a, b) => eq([...a].sort(), [...b].sort());
const constChecks = [
  ["살아 있는 상태 (웹 = aggregator)", web.live_statuses, agg.live_statuses],
  ["살아 있는 상태 (웹 = syncer)", web.live_statuses, syn.live_statuses],
  ["휴가 종류 (웹 = aggregator)", web.leave_types, agg.leave_types],
  ["근무 종류 (웹 = aggregator)", web.work_types, agg.work_types],
  ["휴가·근무 종류 (웹 = aggregator)", web.leave_work_types, agg.leave_work_types],
  ["휴가·근무 종류 (웹 = syncer)", web.leave_work_types, syn.leave_work_types],
];
for (const [label, a, b] of constChecks) {
  total++;
  if (!sameSet(a, b)) {
    fail++;
    console.log(`✗ 상수 ${label} — ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  }
}

console.log(`parity: ${total - fail}/${total} 일치${fail ? ` — ${fail}건 불일치` : ""}`);
process.exit(fail ? 1 : 0);
