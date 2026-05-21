# HR Aggregator

`hr.presence_raw` (raw 출입 데이터) → `hr.attendance_daily` (확정 출퇴근) 변환 데몬.

## 동작
- 매 60초마다 활성 직원 각각의 오늘 presence_raw 분석
- 출근 = 그날 첫 'online'의 checked_at
- 퇴근 = 그날 마지막 'offline'의 checked_at (단, 그 후 'online'이 없을 때만)
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

## 신도림 단독 환경
- 현재 다중 지점 미지원. site_id 컬럼 사용 안 함.
- 추후 다중 지점 확장 시 employees.site_id 또는 별도 sites 테이블 도입 예정.
