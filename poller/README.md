# vanam-hr Poller

ipTIME 라우터에 SNMPv2c 쿼리를 주기적으로 보내 직원 디바이스의 WiFi 접속 여부를 추적하는 영구 실행 데몬.

## 운영 환경

- **운영 위치**: NAS Linux Docker (Synology)
- **개발 환경**: NAS 환경 사용 (Windows에선 easysnmp 빌드 불가)
- **라이브러리**: easysnmp (net-snmp C 바인딩, sync 호출)
- **컨테이너**: `hr-poller` (동일 vanam-db-net 네트워크)

## 보안 주의

- **레포는 public 상태**. 실제 라우터 IP, SNMP community 문자열, 직원 MAC 주소는 **절대 코드/문서에 노출 금지**.
- 모든 민감 값은 프로젝트 루트 `.env` (gitignored)에 저장.
- 로그에 MAC 주소는 자동 마스킹 (예: `aa:bb:cc:**:**:**`).
- 신규 환경변수 추가 시 `.env.example` 에는 placeholder만.

## 환경변수 (.env에 추가)

```
SNMP_COMMUNITY=your_16_char_community_string
POLLER_DB_HOST=inventory-web-postgres
POLLER_DB_PORT=5432
POLLER_DB_NAME=your_database_name
POLLER_DB_USER=your_user
POLLER_DB_PASSWORD=your_password_special_chars_ok
POLLER_LOG_LEVEL=INFO
POLLER_LOG_FILE=/app/logs/poller.log
POLLER_DRY_RUN=false
```

NAS 환경에서:
- `POLLER_DB_HOST` = `inventory-web-postgres` (컨테이너 이름)
- `POLLER_DB_PORT` = `5432` (컨테이너 내부 포트)

## DB 정책 키 (이미 시드됨)

- `snmp_router_ip`: 라우터 IP (폴러가 시작 시 + 5분마다 재로드)
- `debounce_minutes`: Phase 5 aggregator용 (폴러는 사용 X)

## 폴링 주기 (hr.polling_schedules 시드 3건)

| 시간대 | 주기 |
|------|------|
| 평일 평상시 | 10초 |
| 평일 출퇴근 피크 (8:30~19:30) | 5초 |
| 주말 | 30초 |

UI의 정책 페이지에서 시드 변경 시 5분 이내 자동 반영.

## NAS 배포

```bash
# NAS SSH
cd /volume1/docker/hr-web
sudo bash deploy-poller.sh
```

`deploy-poller.sh`가 자동으로:
1. git pull (최신 코드)
2. docker compose build poller
3. 기존 컨테이너 중단
4. docker compose up -d poller

## 동작 검증

```bash
# 로그 실시간 확인
sudo docker logs -f hr-poller

# 본인 폰 WiFi 토글 → presence_raw 확인
# (DBeaver 또는 NAS에서)
psql -h localhost -p 5433 -U inv_user -d inventory -c \
  "SET search_path TO hr; SELECT * FROM presence_raw ORDER BY checked_at DESC LIMIT 10;"
```

## 종료 / 재시작

```bash
sudo docker compose stop poller    # 중단
sudo docker compose start poller   # 재시작
sudo docker compose restart poller # 재기동
```

`restart: unless-stopped` 정책이라 NAS 재부팅 시 자동 복구.
