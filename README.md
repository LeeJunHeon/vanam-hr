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

## License

Proprietary. © VanaM Inc.