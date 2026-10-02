# HR Aggregator

`hr.presence_raw` (raw 출입 데이터) → `hr.attendance_daily` (확정 출퇴근) 변환 데몬.

## 동작
- 매 60초마다 활성 직원 각각의 어제+오늘 두 work_date presence_raw 분석 (시나리오 A: employee 단위 통합 timeline, location 무관)
- 근무일 창 = cutoff(04:00) ~ 다음 날 cutoff (`day_rules.day_presence`)
- 출근 = 창 안 첫 'online'. 이월(04:00 직전 마지막 기록이 online — 04:00 에 연결 중)이면 아래 경계 규칙
- 퇴근 = 창 안 마지막 기록이 'offline' 이고 그 뒤 grace_minutes 동안 재연결이 없을 때 그 offline 시각.
  마지막 상태가 online 이면 근무중, 다음 날 04:00 이 지나면 다음 날 경계 규칙으로 정한다
- 출근이 없으면 퇴근도 쓰지 않음(퇴근만 있는 기록 무시). 폰을 회사에 두고 가는 경우는 고려하지 않음(연결 = 근무 중)
- grace_minutes는 hr.policy_settings.debounce_minutes에서 읽음 (기본 60)
- work_date 귀속: 새벽 cutoff_hour 시 이전 활동은 전일 work_date로 (야간 근무자 정책)
- cutoff_hour는 hr.policy_settings.work_date_cutoff_hour에서 읽음 (기본 4)
- attendance_daily에 UPSERT (employee_id, work_date) UNIQUE 기반
- is_overridden=true 인 row는 건드리지 않음 (관리자 수동 수정 보호)
- 근무일 경계(cutoff)를 넘긴 연결(`day_rules.carry_end`): 04:00 에 연결 중이면 "실제로 나간 시각, 또는 그날 근무 시작 시각 P"에서 나눈다.
  P = 알림의 기준 출근(보통 시프트 시작, 오전반차면 반차 끝). 나감 = offline 뒤 grace 분 넘게 재연결 없음.
  · P 전에 나감 → 전날 퇴근 = 나간 시각, 그날은 나간 뒤 기록으로 계산 / P 까지 안 나감 → 전날 퇴근 = 그날 출근 = P
  · P 없음(공휴일·휴무·미배정·종일 휴가 등) → 04:00 에서 나눔 / 아직 모름 → 판단 보류(그날 출퇴근 없음, 전날 퇴근 비움)
- 판단 보류 중인 직원에게는 출근 전 알림·출근 미감지 알림을 보내지 않음

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
