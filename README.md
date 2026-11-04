# vanam-hr

VanaM 인사·근태 관리 시스템

## 개요

VanaM ERP의 인사·근태 관리 모듈입니다.
사내 WiFi(ipTIME AX8004M) SNMP 폴링 기반의 자동 출퇴근 시스템과
휴가·결재 워크플로, Google Calendar 외근 자동 동기화를 제공합니다.

## 기술 스택

- **Frontend**: Next.js 16, TypeScript, Tailwind CSS v4 (PWA)
- **Backend**: Next.js API Routes, Prisma
- **Database**: PostgreSQL 16
- **Auth**: NextAuth (VanaM Portal SSO 연동)
- **Infrastructure**: Synology NAS, Docker
- **Polling Daemon**: Python + net-snmp

## 주요 기능

### 자동 근태 기록
- 사내 WiFi 연결/끊김 SNMP 폴링 (±10초 정확도)
- 그날 첫 연결 = 출근, 마지막 끊김 = 퇴근
- 야간 근무 자동 처리 (work_date 기준)
- 시프트 패턴 자동 순환 (격주 주야간, 3교대 등)

### 결재 워크플로
- 휴가·반차·병가 신청
- 출퇴근 시간 정정 요청
- 부서별 결재선 + 대리 결재자
- 24시간 무응답 시 자동 위임

### 외부 연동
- Google Calendar 외근/출장 자동 동기화 (이벤트 색상 기반)
- VanaM Portal SSO 인증
- Web Push 알림 (PWA)

### 관리자 커스터마이징
- 근태 항목 동적 추가/수정
- 정책 변수 (디바운싱 시간, 본인 확인 주기 등) 관리

## 관련 레포

- [vanam-portal](https://github.com/LeeJunHeon/vanam-portal) - SSO 허브
- [Inventory_web_app](https://github.com/LeeJunHeon/Inventory_web_app) - 재고관리
- [equipment_web_app](https://github.com/LeeJunHeon/equipment_web_app) - 장비관리

## 개발 환경

작업 환경 셋업, 배포 절차는 별도 문서 참고.

## 배포 (NAS)

이미지는 NAS 에서 빌드하지 않는다. main 에 push 하면 GitHub Actions(`.github/workflows/docker-publish.yml`)가 이미지를 빌드해
이미지 네 개(`ghcr.io/leejunheon/hr-web`(빌드 인자 `NEXT_PUBLIC_BASE_PATH=/hr`)·`hr-poller`·`hr-aggregator`·`hr-calendar-syncer`, 태그 `<커밋 SHA>`·`:latest`) 로 올리고, NAS 는 그 이미지를 받아 재시작만 한다.

1. push 뒤 Actions 가 성공했는지 본다: https://github.com/LeeJunHeon/vanam-hr/actions
2. NAS `/volume1/docker/hr-web` 에서 바꾼 서비스의 스크립트를 실행한다: `sudo ./deploy.sh`(웹 hr-nextjs)·`sudo ./deploy-poller.sh`·`sudo ./deploy-aggregator.sh`·`sudo ./deploy-calendar.sh` — git pull → 그 커밋 이미지 받기 → `:deployed` 로 바꾸기 → `docker compose up -d` → 실행 확인(옛 이미지는 지우지 않는다).
   그 커밋 이미지가 아직 없으면(빌드 중·실패·로그인 안 됨) Actions 주소를 안내하고 아무것도 바꾸지 않은 채 멈춘다.
3. 문제가 있으면 `rollback` 인자 — 바로 전 이미지(`:previous`)와 맞바꾼다(git pull 하지 않음).
4. GitHub 을 쓸 수 없을 때만 `--build` 인자(비상용) — 예전처럼 NAS 에서 직접 빌드해 `:deployed` 로 쓴다.
5. **한 번에 한 앱씩 배포한다**(다른 앱 배포 중이면 멈춘다). NAS 1분 평균 부하가 6 초과이거나 여유 메모리가 500MB 미만이면
   시작하지 않는다 — 확인하고 꼭 해야 할 때만 `sudo GHCR_FORCE=1 ./deploy.sh`(rollback·--build 와 같이 쓸 수 있다). 옛 이미지는 새벽 야간 정리 작업이 지운다.
- 네 스크립트는 같은 공용 함수(`scripts/ghcr-deploy.sh`)를 쓰고 각자 자기 서비스·이미지만 배포한다(예: `sudo ./deploy-poller.sh rollback`).

- 처음 한 번: NAS 에서 `sudo git pull`(새 배포 스크립트 받기) → `sudo docker login ghcr.io`(GitHub 사용자 이름 + `read:packages` 권한
  토큰. 공개 저장소 이미지는 로그인 없이도 받을 수 있다) → 배포. 처음에는 `:previous` 가 없어 되돌리기는 `--build` 로 한다.
- 배포 기록은 앱 폴더의 `.deploy-state`(git 에 넣지 않음)에 이미지마다 현재·이전 커밋 SHA 와 시각으로 남는다. 공용 함수는 `scripts/ghcr-deploy.sh`.
- 예전에 NAS 에서 빌드한 이미지(compose 기본 이름)는 자동으로 지우지 않는다. `sudo docker images` 로 확인해 쓰지 않는 것만 지운다.

## 규칙 검사 (parity)

근태 판정·종류 목록·날짜 규칙은 웹(TS, `lib/`)과 aggregator·calendar-syncer(Python)에 같은 내용이 두 번 있다.
두 쪽이 어긋나지 않도록 같은 케이스 파일(`tests/parity/cases.json`)을 양쪽 실행기로 돌려 비교한다.
규칙 파일(`aggregator/day_rules.py`, `calendar-syncer/calendar_sync.py`, `lib/attendance-judge.ts` 등)을 바꾸면
`npm run parity` 를 돌리고, 새 규칙이면 케이스도 추가한다. (Python 은 `python3`/`python`, 또는 `PYTHON` 환경변수)

## License

Proprietary. © VanaM Inc.