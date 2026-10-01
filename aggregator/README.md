# HR Aggregator

`hr.presence_raw` (raw 출입 데이터) → `hr.attendance_daily` (확정 출퇴근) 변환 데몬.

## 동작
- 매 60초마다 활성 직원 각각의 어제+오늘 두 work_date presence_raw 분석 (시나리오 A: employee 단위 통합 timeline, location 무관)
- 출근 = 그날 첫 'online'의 checked_at
- 퇴근 = 그날 마지막 기록이 'offline' 이고 그 뒤 grace_minutes 동안 재연결이 없을 때 그 offline 시각 (마지막이 online 이면 근무중)
- grace_minutes는 hr.policy_settings.debounce_minutes에서 읽음 (기본 60)
- work_date 귀속: 새벽 cutoff_hour 시 이전 활동은 전일 work_date로 (야간 근무자 정책)
- cutoff_hour는 hr.policy_settings.work_date_cutoff_hour에서 읽음 (기본 4)
- attendance_daily에 UPSERT (employee_id, work_date) UNIQUE 기반
- is_overridden=true 인 row는 건드리지 않음 (관리자 수동 수정 보호)
- 근무일 경계(cutoff)를 넘긴 연결: 경계에 연결된 채 넘어간 세션은 연장 시간 M(`overnight_extend_max_hours`, 기본 6, 0~12) 안에서 끝(뒤로 grace 이상 재연결 없는 offline)을 찾는다.
  M 안에 끝나면 전날 퇴근 = 끝난 시각(그 사이 기록은 전날 몫), M 이 지나도록 안 끝나면 경계에서 나눈다(전날 퇴근 = 경계, 다음 날 출근 = 경계 — 이월 출근), 그 사이는 판단 대기.
  `overnight_extend_enabled` 를 끄면 연장 0시간(경계에서 바로 나눔). 이월 출근 날은 그날 몫 기록이 처음 생길 때 행이 생긴다(종일 변화 없는 날은 행 없음).
  알려진 한계: 폰을 회사에 두고 가면 밤샘처럼 보인다(근태 정정으로 고침). 규칙: `day_rules.boundary_session`
- 창에 online이 하나도 없으면 check_out을 확정하지 않음 (전일 세션 꼬리 → 유령 행 방지). `overnight_extend_enabled` 가 켜졌을 때만 적용

## 테스트
- 경계를 넘긴 연결 등 aggregator 테스트(가짜 DB): `python tests/aggregator/test_overnight.py` (프로젝트 루트에서)
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
