# HR Aggregator

`hr.presence_raw` (raw 출입 데이터) → `hr.attendance_daily` (확정 출퇴근) 변환 데몬.

## 동작
- 매 60초마다 활성 직원 각각의 어제+오늘 두 work_date presence_raw 분석 (시나리오 A: employee 단위 통합 timeline, location 무관)
- 근무일 창 = cutoff(04:00) ~ 다음 날 cutoff. 다음 날 기록은 보지 않는다(`day_rules.day_presence`)
- 출근 = 이월(04:00 직전 마지막 기록이 online — 04:00 에 연결 중)이면 04:00, 아니면 창 안 첫 'online'
- 퇴근 = 창 안 마지막 기록이 'offline' 이고 그 뒤 grace_minutes 동안 재연결이 없을 때 그 offline 시각.
  마지막 상태가 online 이면 근무중, 다음 날 04:00 이 지나면 퇴근 = 다음 날 04:00(경계 퇴근)
- 출근이 없으면 퇴근도 쓰지 않음(퇴근만 있는 기록 무시). 폰을 회사에 두고 가는 경우는 고려하지 않음(연결 = 근무 중)
- grace_minutes는 hr.policy_settings.debounce_minutes에서 읽음 (기본 60)
- work_date 귀속: 새벽 cutoff_hour 시 이전 활동은 전일 work_date로 (야간 근무자 정책)
- cutoff_hour는 hr.policy_settings.work_date_cutoff_hour에서 읽음 (기본 4)
- attendance_daily에 UPSERT (employee_id, work_date) UNIQUE 기반
- is_overridden=true 인 row는 건드리지 않음 (관리자 수동 수정 보호)
- 근무일 경계(cutoff)를 넘긴 연결: 연장 없이 04:00 에서 자른다. 04:00 에 연결 중이면 전날 퇴근 = 04:00, 그날 출근 = 04:00(이월). 이월 출근 날은 연결 변화가 없어도 행이 생긴다

## 테스트
- aggregator 하루 계산 테스트(가짜 DB): `python tests/aggregator/test_day_presence.py` (프로젝트 루트에서)
- 웹과 같아야 하는 규칙(day_rules.py)을 바꾸면 `npm run parity`

## 로컬 실행
```bash
cd aggregator
pip install -r requirements.txt
python aggregator.py
```

`.env`는 프로젝트 루트(`vanam-hr/.env`)에 있어야 함.

## Docker
```bash
docker compose up -d aggregator
docker logs -f hr-aggregator
```

## 다중 지점 (본사 + 공덕)
- 시나리오 A 정확 구현 완료 (2026-05-27). employee 단위 통합 timeline 사용.
- presence_raw.location 컬럼은 무시 (디버깅/UI용으로만 유지).
- 같은 직원이 본사 ↔ 공덕 이동해도 출퇴근 1건만 기록됨.
- 외근 처리 (Google Calendar 연동)는 Phase 6에서.
