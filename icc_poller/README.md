# ICC Poller

공덕 사무실용 ipTIME ICC HTTP API 폴러.

## 개요

- 신도림 SNMP 폴러(poller/)와 동일한 패턴
- ICC API (`POST /cgi/service.cgi`)로 station 리스트 조회
- `hr.presence_raw`에 `location='공덕'`으로 INSERT
- 세션 쿠키 자동 관리 (만료 시 재로그인)
- 60초 주기 polling

## 환경변수

`.env` 파일 (프로젝트 루트):

| 키 | 설명 | 예시 |
|---|---|---|
| ICC_URL | ICC 컨테이너 URL | http://192.168.0.210:8800 |
| ICC_USER | ICC admin ID | vanam6644653c |
| ICC_PASSWORD | ICC admin 비밀번호 | (secret) |
| ICC_SITE_ID | 공덕 사이트 ID | 1 |
| POLLER_DB_* | DB 접속 정보 (신도림 폴러와 동일) | |

## 컨테이너

- 컨테이너명: `hr-icc-poller`
- 네트워크: host (ICC가 host port 8800에 있음)
- 빌드: `sudo docker compose build icc_poller`
- 배포: `sudo /volume1/docker/hr-web/deploy-icc-poller.sh`

## 로그

- 위치: `icc_poller/logs/icc-poller.log`
- 로테이션: 5MB × 3개
- MAC 마스킹: INFO에서는 앞 3옥텟만 (`aa:bb:cc:**:**:**`)
