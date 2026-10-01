# Calendar Syncer

VanaM HR — Google Calendar 연동 (Phase 6).

## 개요

- **일정 동기화 (기본 10분마다)** — 주기는 `policy_settings.calendar_sync_interval_minutes`
  (5~1440 으로 자름, 없거나 숫자가 아니면 10). 루프마다 다시 읽어 재시작 없이 반영된다.
  - 동기화 대상 캘린더(`calendar_sources.sync_enabled=true`)의 **오늘** 일정을 모든 페이지 읽는다.
  - 시스템이 만든 일정(`extendedProperties.private.vanam_source`, 설명 태그)은 건너뛴다.
  - 키워드 → 카테고리 판정 후, 대상 직원마다 `attendance_requests`(external_source `google_calendar`)
    행을 만들거나 바뀐 값만 갱신한다. 같은 카테고리의 HR 신청과 기간이 겹치면 만들지 않는다.
  - 대상 직원: 직원 참석자가 있으면 수락(accepted)한 직원만, 없으면 만든 사람.
- **빠진 기록 정리** — 모든 캘린더 조회에 성공한 사이클에서만, 오늘을 덮는 살아 있는 행 중
  이번에 보이지 않은 기록을 정리한다: 오늘 시작이면 **취소**, 지난 날에 시작했으면 종료일을 **어제로 단축**
  (지난 날 보존). 출장보고서가 있으면 취소하지 않고, 한 사이클 30건을 넘으면 아무것도 하지 않는다.
- **취소 출처(`cancel_source`)** — `user`: 웹에서 본인·관리자가 취소 / `calendar_sync`: 동기화가 정리하며 취소.
  동기화는 `calendar_sync` 로 취소한 행만, 일정이 다시 보이면 되살린다(HR 겹침 검사 후).
  사람이 취소한 행(`user`)과 이전 취소(NULL)는 일정이 남아 있어도 되살리지 않는다.
- **근태 반영** — 신청 변경에 맞춰 attendance_daily 를 웹과 같은 규칙으로 반영한다
  (지난 날은 재계산 표시, 앞날 흔적 행 정리 등 — `calendar_sync.py`).
- **매일 04:00** — 공휴일 동기화(KASI)와 보관기간 정리(purge). 부팅 직후에는 공휴일 1번 + 일정 동기화 1번.
- **내부 HTTP API** — `POST/PATCH/DELETE /internal/calendar-event`, `GET /internal/health`
  (HR 결재 승인·출장 변경 때 일정 등록·수정·삭제).
- 규칙(상수·날짜)을 바꾸면 프로젝트 루트에서 `npm run parity`.

## 인증

- 서비스 계정 + 도메인 위임(`with_subject`) 방식.
- admin.google.com 도메인 위임 설정은 **이미 완료됨**
  (등록 scope: `https://www.googleapis.com/auth/calendar`).
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
| CALENDAR_WRITE_TARGET_ID | 일정 등록 기본 캘린더 ID | (필수) |
| INTERNAL_API_TOKEN | 내부 HTTP API 토큰 | (필수) |
| CALENDAR_HTTP_PORT | 내부 HTTP API 포트 | 8765 |
| KASI_SERVICE_KEY | 공휴일(KASI) API 키 | (없으면 공휴일 동기화 생략) |
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
- 일정 동기화 사이클마다 요약 1줄(신규·갱신·되살림·변경없음·HR겹침·취소유지·충돌·오류, 정리 취소·단축)
- 바뀐 것(신규·갱신·되살림·취소·단축)은 info, 매 사이클 반복되는 줄은 debug
