# HR Aggregator

`hr.presence_raw` (raw 출입 데이터) → `hr.attendance_daily` (확정 출퇴근) 변환 데몬.

## 동작
- 매 60초마다 활성 직원 각각의 어제+오늘 두 work_date presence_raw 분석 (시나리오 A: employee 단위 통합 timeline, location 무관)
- 출근 = 그날 첫 'online'의 checked_at
- 퇴근 = 그날 마지막 'online'의 checked_at (단, 현재 시각 - last_online >= grace_minutes 일 때만 확정)
- grace_minutes는 hr.policy_settings.debounce_minutes에서 읽음 (기본 60)
- work_date 귀속: 새벽 cutoff_hour 시 이전 활동은 전일 work_date로 (야간 근무자 정책)
- cutoff_hour는 hr.policy_settings.work_date_cutoff_hour에서 읽음 (기본 4)
- attendance_daily에 UPSERT (employee_id, work_date) UNIQUE 기반
- is_overridden=true 인 row는 건드리지 않음 (관리자 수동 수정 보호)

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
