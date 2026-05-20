# vanam-hr Poller

ipTIME 라우터에 SNMPv2c 쿼리를 주기적으로 보내 직원 디바이스의 WiFi 접속 여부를 추적하는 영구 실행 데몬.

## 보안 주의

- **레포는 public 상태**. 실제 라우터 IP, SNMP community 문자열, 직원 MAC 주소는 **절대 코드/문서에 노출 금지**.
- 모든 민감 값은 프로젝트 루트 `.env` (gitignored)에 저장.
- 로그에 MAC 주소는 자동 마스킹 (예: `aa:bb:cc:**:**:**`).
- 신규 환경변수 추가 시 `.env.example` 에는 placeholder만.

## 동작 개요

1. `hr.policy_settings` 에서 `snmp_router_ip` 조회 (5분마다 캐시 갱신)
2. `hr.devices` 의 활성 디바이스 MAC 목록 로드
3. SNMP walk (MAC 테이블 + 연결 상태) — `pysnmp-lextudio` asyncio API, 세션 재사용으로 1~2초 응답
4. 매칭된 MAC을 `hr.presence_raw` 에 적재
   - `online` 상태가 이미 마지막인 경우엔 `devices.last_seen_at` 만 갱신 (중복 INSERT 방지)
   - SNMP 응답에서 사라진 활성 디바이스는 마지막 상태가 `online` 이었을 때만 `offline` INSERT
5. `hr.polling_schedules` 에서 현재 시각·요일에 매칭되는 priority 최상위 row 의 `intervalSeconds` 만큼 대기 (기본 30초)

## 로컬 실행 (개발/테스트)

### 1. 가상환경 + 의존성

```cmd
cd poller
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### 2. `.env` 확인

프로젝트 루트의 `.env` 에 다음이 있어야 함:

- `SNMP_COMMUNITY` (16자 무작위)
- `POLLER_DB_HOST` (예: `192.168.0.x`)
- `POLLER_DB_PORT` (기본 `5432`)
- `POLLER_DB_NAME`
- `POLLER_DB_USER`
- `POLLER_DB_PASSWORD` (특수문자 그대로 OK — URL 인코딩 불필요)
- `POLLER_LOG_LEVEL=INFO` (선택)
- `POLLER_LOG_FILE=poller/poller.log` (선택)
- `POLLER_DRY_RUN=false` (true면 DB INSERT 안 함, 로그만)

> **DB 연결 환경변수 분리 이유**: Next.js Prisma는 `DATABASE_URL` 의
> 쿼리 파라미터(`?schema=hr`)를 사용하지만 psycopg2는 invalid DSN으로 거부함.
> 또한 비밀번호에 `!`, `@` 등 특수문자가 들어가면 URL 파싱이 깨지므로
> psycopg2에는 host/port/dbname/user/password를 keyword args로 분리 전달.

### 3. 실행

```cmd
python poller.py
```

콘솔 출력 + `poller/poller.log` 파일(기본 위치)에 기록.

### 4. 정상 동작 검증

본인 폰을 사내 WiFi에 접속/해제하면서:

- `online: aa:bb:cc:**:**:**` 로그 출력 확인
- DBeaver에서 `SELECT * FROM hr.presence_raw ORDER BY checked_at DESC LIMIT 10;` 로 적재 확인
- `devices` 페이지의 "마지막 접속" 컬럼이 "방금" 또는 "1분 전" 표시 확인

### 5. 종료

`Ctrl+C` (SIGINT) — 다음 루프 진입 전 안전 종료.

## 폴링 주기

`hr.polling_schedules` 시드 기준:

- 평일 평상시: 10초
- 평일 출퇴근 피크 (08:30~19:30): 5초
- 주말: 30초

UI의 정책/스케줄 변경 시 5분 이내 자동 반영.

## 로그 예시 (INFO)

```
[2026-05-20 09:00:01] INFO: Poller 시작
[2026-05-20 09:00:01] INFO: DRY_RUN=false, LOG_LEVEL=INFO
[2026-05-20 09:00:03] INFO: 라우터 IP 변경 감지 (또는 초기 설정). SnmpClient 재초기화.
[2026-05-20 09:00:05] INFO: online: aa:bb:cc:**:**:** (device_id=1, employee_id=1, ssid=VanaM_5G)
[2026-05-20 18:15:32] INFO: offline: aa:bb:cc:**:**:** (device_id=1, employee_id=1)
```

DEBUG 레벨로 올리면 다음 폴링까지 대기 시간 등 상세 로그도 표시.

## 트러블슈팅

- **SNMP timeout**: 라우터 IP / community 재확인. 사내망 외부에서는 접근 불가.
- **DB 연결 실패**: `.env` 의 `DATABASE_URL` 형식 + 네트워크 reachability 확인.
- **활성 디바이스 0건**: `devices` 페이지에서 직원 폰 등록 필요.
- **`pysnmp-lextudio` 설치 실패**: Python 3.13 호환 버전 (>=6.1) 확인. `pip` 캐시 비우고 재시도.

## Phase 8 (운영 배포)

`Dockerfile` 은 작성되어 있지만 이번 Phase 4에서는 사용하지 않음. NAS Docker로 배포할 때 `docker compose` 에 별도 서비스로 추가 예정.
