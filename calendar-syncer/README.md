# Calendar Syncer

VanaM HR — Google Calendar 연동 (Phase 6).

## 개요 (1단계: 읽기 전용 뼈대)

- 30분마다 근태 관련 캘린더 4개(휴가/외근/외부미팅/온사이트)를 읽어
  일정 + 직원 매칭(creator.email ↔ hr.employees.email)을 **로그로만** 출력한다.
- **DB 쓰기 없음 / 캘린더 쓰기 없음** — 이번 단계는 인증 + DB 연결 + 캘린더 읽기 검증만.
- 근태 보정(attendance_daily 쓰기)·캘린더 생성은 추후 단계에서 추가.

## 인증

- 서비스 계정 + 도메인 위임(`with_subject`) 방식.
- admin.google.com 도메인 위임 설정은 **이미 완료됨**
  (등록 scope: `https://www.googleapis.com/auth/calendar`,
  1단계는 그 하위 집합인 `calendar.readonly` 사용).
- 서비스 계정 키는 `calendar-syncer/secrets/service-account-key.json`에 둔다.
  **이 파일은 git에 올리지 않는다** (`.gitignore`로 제외).

## 환경변수

`.env` 파일 (프로젝트 루트 `vanam-hr/.env`):

| 키 | 설명 | 기본값 |
|---|---|---|
| CALENDAR_DB_HOST | DB 호스트 | inventory-web-postgres |
| CALENDAR_DB_PORT | DB 포트 | 5432 |
| CALENDAR_DB_NAME | DB 이름 (aggregator와 동일) | (필수) |
| CALENDAR_DB_USER | DB 사용자 (aggregator와 동일) | (필수) |
| CALENDAR_DB_PASSWORD | DB 비밀번호 (aggregator와 동일) | (필수) |
| CALENDAR_SUBJECT_EMAIL | 도메인 위임 대행 계정 | (필수) |
| CALENDAR_KEY_FILE | 서비스 계정 키 경로 | /app/secrets/service-account-key.json |
| CALENDAR_SYNC_INTERVAL | 동기화 주기(초) | 1800 (30분) |
| CALENDAR_READ_DAYS_AHEAD | 오늘부터 며칠 뒤까지 읽을지 | 7 |
| CALENDAR_LOG_LEVEL | 로그 레벨 | INFO |
| CALENDAR_LOG_FILE | 로그 파일 경로 | /app/logs/calendar-syncer.log |

## 로컬 실행

```bash
cd calendar-syncer
pip install -r requirements.txt
# secrets/service-account-key.json 배치 후
python syncer.py
```

`.env`는 프로젝트 루트(`vanam-hr/.env`)에 있어야 함.

## Docker

```bash
docker compose up -d calendar-syncer
docker logs -f hr-calendar-syncer
```

- 컨테이너명: `hr-calendar-syncer`
- 네트워크: internal + vanam-db-net (DB는 `inventory-web-postgres:5432`)
- 빌드: `sudo docker compose build calendar-syncer`
- 배포: `sudo /volume1/docker/hr-web/deploy-calendar.sh`

## 로그

- 위치: `calendar-syncer/logs/calendar-syncer.log`
- 로테이션: 5MB × 3개
- 캘린더별로 "종일 N건 / 시간지정 M건 / 직원매칭 K건" 요약 출력
