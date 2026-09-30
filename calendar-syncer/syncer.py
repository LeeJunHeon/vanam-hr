"""Google Calendar 동기화 데몬 + 캘린더 쓰기 endpoint.

흐름:
1. config 로드 → logger 셋업 → DB 연결 → CalendarClient 인증 (도메인 위임)
2. Flask HTTP 서버를 별도 스레드로 시작 (내부망 전용)
   - POST/PATCH/DELETE /internal/calendar-event: HR·재고관리 등 내부 시스템이 일정 등록·수정·삭제
   - GET  /internal/health: liveness 체크
3. 메인 루프 (60초마다 깨어남):
   - 일정 동기화(sync_events): N분마다. N = policy_settings 'calendar_sync_interval_minutes'
     (5~1440, 없거나 숫자가 아니면 10). 루프마다 다시 읽어 재시작 없이 반영.
   - 공휴일 동기화(KASI) + 보관기간 정리(purge): 매일 04:00 KST 1번.
   - 부팅 직후: 공휴일 1번 + 일정 동기화 1번.

일정 동기화 (판단 규칙은 calendar_sync.py):
- 당일 일정만 읽는다(모든 페이지). 시스템 생성 일정(vanam_source·설명 태그)은 스킵.
- 키워드 → 카테고리 판정, 대상 직원 선정 → 직원별 google_calendar 신청 행 업서트.
- 사람 취소(cancel_source 'user')·이전 취소는 되살리지 않는다. 동기화가 취소한 행('calendar_sync')만
  일정이 다시 보이면 되살린다.
- 모든 캘린더 조회에 성공한 사이클에서만, 캘린더에서 빠진 기록을 정리한다(오늘 시작=취소,
  지난 시작=어제로 단축).
- 신청 변경에 맞춰 근태(attendance_daily)를 웹과 같은 규칙으로 반영한다.
"""

import os
import signal
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests
from flask import Flask, jsonify, request

from config import load_config
from db import Database
from logger import setup_logger
from calendar_client import CalendarClient
from calendar_sync import (
    CLEANUP_SAFETY_CAP,
    apply_event_for_employee,
    execute_cleanup,
    parse_event_times,
    plan_cleanup,
    resolve_sync_interval,
    select_target_emails,
)

# 한국 시간대 (UTC+9). ZoneInfo 대신 고정 오프셋 사용 (한국은 DST 없음).
KST = timezone(timedelta(hours=9))

# 실행 시각 (KST 기준)
RUN_HOUR = 4
RUN_MINUTE = 0

# 메인 루프 체크 주기 (초)
CHECK_INTERVAL_SECONDS = 60

# ============================================================================
# 데이터 보관기간 정리(purge) 설정
# ============================================================================
PURGE_ENABLED = False   # 테스트 단계: 로그만 남기고 실제 삭제 안 함. 확신 들면 True로 바꿔 재배포.

PRESENCE_RAW_RETENTION = '3 months'
ATTENDANCE_DAILY_UNCONFIRMED_RETENTION = '1 year'
ATTENDANCE_DAILY_CONFIRMED_RETENTION = '3 years'
ATTENDANCE_REQUESTS_RETENTION = '3 years'
MONTHLY_CONFIRMATIONS_RETENTION = '3 years'

# 한 번에 이 건수보다 많이 지우려 하면 버그로 보고 중단
PURGE_SAFETY_CAP_PRESENCE_RAW = 50000
PURGE_SAFETY_CAP_DEFAULT = 10000


def _is_valid_date(s) -> bool:
    """YYYY-MM-DD 형식 검증."""
    if not isinstance(s, str):
        return False
    if len(s) != 10:
        return False
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return True
    except ValueError:
        return False


class Syncer:
    def __init__(self):
        self.config = load_config()
        self.logger = setup_logger(self.config.log_level, self.config.log_file)
        self.running = True
        self.last_run_date = None  # 공휴일·purge 같은 날 중복 실행 방지
        self.last_events_sync_at = None  # 마지막 일정 동기화 시작 시각 (KST aware)
        # 출장보고서가 있어 취소하지 못한 행 warning 을 하루 1번만: {request_id: date}
        self._trip_report_warned: dict = {}

        self.logger.info("Calendar Syncer 시작")
        self.logger.info(
            f"공휴일·purge: 매일 {RUN_HOUR:02d}:{RUN_MINUTE:02d} KST, "
            f"일정 동기화: policy calendar_sync_interval_minutes 분마다, "
            f"SUBJECT={self.config.subject_email}"
        )

        # DB 연결 — psycopg2 연결 1개. 메인 루프 스레드만 쓴다(일정·공휴일 동기화, purge).
        # HTTP 핸들러(별도 스레드)에서 DB 를 쓰려면 이 연결을 공유하지 말고 별도 연결을 만들 것.
        self.db = Database(
            host=self.config.db_host,
            port=self.config.db_port,
            dbname=self.config.db_name,
            user=self.config.db_user,
            password=self.config.db_password,
        )

        # Google Calendar 인증
        self.client = CalendarClient(
            key_file=self.config.key_file,
            subject_email=self.config.subject_email,
        )

        # HTTP 서버 (재고관리 등 내부 시스템이 일정 등록할 때 사용)
        self.http_app = self._create_http_app()
        self.http_thread = None

        self.logger.info("초기화 완료")

    def _create_http_app(self) -> Flask:
        """Flask 앱 생성. /internal/calendar-event(POST/PATCH/DELETE) + /internal/health.

        스레드: threaded=True 라 요청마다 별도 스레드. 구글 API 는 self.client 가 요청마다 새 연결을
        만들어 스레드 안전하다. self.db 는 쓰지 않는다(메인 루프 전용 — 필요하면 별도 연결).

        - X-Internal-Token 헤더로 인증 (env INTERNAL_API_TOKEN과 비교)
        - 같은 docker network의 컨테이너만 접근 (expose만, ports 매핑 X)
        - vanam_source 표시(어떤 값이든)로 syncer 무한루프 방지

        POST body 두 가지 포맷 지원:
          [A] 신규(HR): {calendar_id, vanam_source, summary, description,
                        start: {date|dateTime}, end: {date|dateTime}}
              → Google Calendar 네이티브 body 그대로 사용
          [B] 기존(inventory): {title, startDate, endDate}
              → title/날짜로 종일 일정 (CALENDAR_WRITE_TARGET_ID에 등록)
        """
        app = Flask(__name__)

        @app.get("/internal/health")
        def health():
            return jsonify({"ok": True}), 200

        @app.post("/internal/calendar-event")
        def create_calendar_event():
            # 1) 토큰 검증
            token = request.headers.get("X-Internal-Token")
            if not token or token != self.config.internal_api_token:
                self.logger.warning(
                    f"인증 실패 (X-Internal-Token 누락 또는 불일치): "
                    f"remote={request.remote_addr}"
                )
                return jsonify({"ok": False, "error": "Unauthorized"}), 401

            # 2) Body 파싱
            try:
                data = request.get_json(force=True, silent=False)
            except Exception:
                return jsonify({"ok": False, "error": "Invalid JSON"}), 400

            if not isinstance(data, dict):
                return jsonify({"ok": False, "error": "Body must be JSON object"}), 400

            # 포맷 판별: summary 있으면 신규(HR) 포맷, 아니면 기존(inventory) 포맷
            is_new_format = "summary" in data and "start" in data

            try:
                if is_new_format:
                    # ===== 신규 포맷 (HR 결재 → 캘린더 등록) =====
                    summary = data.get("summary")
                    description = data.get("description") or ""
                    start_obj = data.get("start") or {}
                    end_obj = data.get("end") or {}
                    calendar_id = (
                        data.get("calendar_id") or self.config.write_target_id
                    )
                    vanam_source = data.get("vanam_source") or "hr"

                    if not summary or not isinstance(summary, str) or not summary.strip():
                        return jsonify({"ok": False, "error": "summary is required"}), 400
                    if not isinstance(start_obj, dict) or not isinstance(end_obj, dict):
                        return jsonify(
                            {"ok": False, "error": "start/end must be objects"}
                        ), 400
                    # 종일 vs 시간 지정 검증
                    has_start_date = "date" in start_obj
                    has_start_dt = "dateTime" in start_obj
                    has_end_date = "date" in end_obj
                    has_end_dt = "dateTime" in end_obj
                    if not (has_start_date or has_start_dt):
                        return jsonify(
                            {"ok": False, "error": "start.date or start.dateTime required"}
                        ), 400
                    if not (has_end_date or has_end_dt):
                        return jsonify(
                            {"ok": False, "error": "end.date or end.dateTime required"}
                        ), 400

                    body = {
                        "summary": summary,
                        "description": description,
                        "start": start_obj,
                        "end": end_obj,
                        "extendedProperties": {
                            "private": {
                                "vanam_source": vanam_source,
                            }
                        },
                    }

                    # Phase 7 추가: location 문자열 / attendees 이메일 배열.
                    # 없거나 빈 값이면 body에 포함하지 않음(하위호환).
                    location_in = data.get("location")
                    if isinstance(location_in, str) and location_in.strip():
                        body["location"] = location_in.strip()
                    attendees_in = data.get("attendees")
                    if isinstance(attendees_in, list):
                        valid_emails = []
                        for a in attendees_in:
                            if isinstance(a, str) and a.strip():
                                valid_emails.append(a.strip())
                        # 중복 제거(순서 유지)
                        seen = set()
                        deduped = []
                        for e in valid_emails:
                            if e.lower() not in seen:
                                seen.add(e.lower())
                                deduped.append(e)
                        if deduped:
                            # responseStatus='accepted'로 미리 표시 → "회신 대기 중" 제거 시도.
                            # 같은 도메인/도메인 위임 권한에 따라 무시될 수 있으나(그 경우
                            # needsAction으로 폴백) 코드상 시도는 안전. sendUpdates='none' 유지.
                            body["attendees"] = [
                                {"email": e, "responseStatus": "accepted"}
                                for e in deduped
                            ]

                    # sendUpdates='none': 참석자에게 초대 메일 발송 X
                    # (이미 근태에서 승인 완료된 일정이므로 메일 불요)
                    created = (
                        self.client.service.events()
                        .insert(
                            calendarId=calendar_id,
                            body=body,
                            sendUpdates="none",
                        )
                        .execute()
                    )
                    event_id = created.get("id", "")
                    self.logger.info(
                        f"캘린더 일정 등록 완료 [신규/{vanam_source}]: "
                        f"summary='{summary}', calendar_id={calendar_id}, "
                        f"eventId={event_id}"
                    )
                    return (
                        jsonify(
                            {
                                "ok": True,
                                "eventId": event_id,
                                "event_id": event_id,  # snake_case alias
                            }
                        ),
                        200,
                    )

                # ===== 기존 포맷 (inventory 등) =====
                title = data.get("title")
                start_date = data.get("startDate")
                end_date = data.get("endDate")

                if not title or not isinstance(title, str) or not title.strip():
                    return jsonify({"ok": False, "error": "title is required"}), 400
                if not _is_valid_date(start_date):
                    return jsonify(
                        {"ok": False, "error": "startDate must be YYYY-MM-DD"}
                    ), 400
                if not _is_valid_date(end_date):
                    return jsonify(
                        {"ok": False, "error": "endDate must be YYYY-MM-DD"}
                    ), 400
                if end_date < start_date:
                    return jsonify(
                        {"ok": False, "error": "endDate must be >= startDate"}
                    ), 400

                # 호환성 fallback (calendar_id / vanam_source body로 받기)
                calendar_id_override = data.get("calendar_id")
                vanam_source = data.get("vanam_source") or "inventory"
                target_calendar_id = (
                    calendar_id_override or self.config.write_target_id
                )

                event_id = self.client.insert_event(
                    calendar_id=target_calendar_id,
                    title=title,
                    start_date=start_date,
                    end_date=end_date,
                    source=vanam_source,
                )
                self.logger.info(
                    f"캘린더 일정 등록 완료 [기존/{vanam_source}]: "
                    f"title='{title}', {start_date}~{end_date}, eventId={event_id}"
                )
                return (
                    jsonify(
                        {
                            "ok": True,
                            "eventId": event_id,
                            "event_id": event_id,
                        }
                    ),
                    200,
                )
            except Exception as e:
                self.logger.exception(f"캘린더 일정 등록 실패: {e}")
                return jsonify({"ok": False, "error": str(e)}), 500

        @app.patch("/internal/calendar-event/<event_id>")
        def patch_calendar_event(event_id):
            """캘린더 일정 부분 수정.

            Phase 7 4단계: 출장 날짜·시간 변경 시 기존 일정을 수정하기 위해 추가.
            Body: {
              calendar_id?: str,            # 없으면 write_target_id
              summary?: str, description?: str,
              start?: {date|dateTime, ...}, # 종일 vs 시간지정
              end?: {date|dateTime, ...},
            }
            전달된 필드만 patch에 포함. 404는 명확한 에러로 반환(멱등 처리하지 않음 —
            호출자가 의도적으로 patch를 요청한 것이므로 대상 없으면 알려준다).
            """
            # 1) 토큰 검증
            token = request.headers.get("X-Internal-Token")
            if not token or token != self.config.internal_api_token:
                self.logger.warning(
                    f"인증 실패 (PATCH, X-Internal-Token 불일치): "
                    f"remote={request.remote_addr}"
                )
                return jsonify({"ok": False, "error": "Unauthorized"}), 401

            if not event_id:
                return jsonify({"ok": False, "error": "event_id required"}), 400

            # 2) Body 파싱
            try:
                data = request.get_json(force=True, silent=True) or {}
            except Exception:
                data = {}
            if not isinstance(data, dict):
                return jsonify({"ok": False, "error": "Body must be JSON object"}), 400

            calendar_id = data.get("calendar_id") or self.config.write_target_id

            # 3) patch body 구성 (전달된 필드만 포함)
            patch_body = {}
            if "summary" in data and isinstance(data["summary"], str):
                patch_body["summary"] = data["summary"]
            if "description" in data and isinstance(data["description"], str):
                patch_body["description"] = data["description"]
            if "start" in data and isinstance(data["start"], dict):
                patch_body["start"] = data["start"]
            if "end" in data and isinstance(data["end"], dict):
                patch_body["end"] = data["end"]
            # Phase 7: location(문자열, "" 입력 시 클리어 의도), attendees(이메일 배열)
            if "location" in data:
                loc = data["location"]
                if loc is None:
                    patch_body["location"] = ""
                elif isinstance(loc, str):
                    patch_body["location"] = loc
            if "attendees" in data and isinstance(data["attendees"], list):
                valid_emails = []
                for a in data["attendees"]:
                    if isinstance(a, str) and a.strip():
                        valid_emails.append(a.strip())
                seen = set()
                deduped = []
                for e in valid_emails:
                    if e.lower() not in seen:
                        seen.add(e.lower())
                        deduped.append(e)
                # responseStatus='accepted'로 미리 표시 (POST와 동일 의도).
                patch_body["attendees"] = [
                    {"email": e, "responseStatus": "accepted"} for e in deduped
                ]

            if not patch_body:
                return (
                    jsonify({"ok": False, "error": "no patchable fields provided"}),
                    400,
                )

            # 4) Google Calendar API patch (메일 미발송)
            try:
                self.client.service.events().patch(
                    calendarId=calendar_id,
                    eventId=event_id,
                    body=patch_body,
                    sendUpdates="none",
                ).execute()
                self.logger.info(
                    f"캘린더 일정 수정 완료: calendar_id={calendar_id}, "
                    f"eventId={event_id}, fields={list(patch_body.keys())}"
                )
                return jsonify({"ok": True, "eventId": event_id}), 200
            except Exception as e:
                err = str(e)
                if "404" in err or "Not Found" in err:
                    self.logger.warning(
                        f"캘린더 일정 수정 대상 없음 (404): eventId={event_id}"
                    )
                    return (
                        jsonify({"ok": False, "error": "event_not_found"}),
                        404,
                    )
                self.logger.exception(f"캘린더 일정 수정 실패: {e}")
                return jsonify({"ok": False, "error": err}), 500

        @app.delete("/internal/calendar-event/<event_id>")
        def delete_calendar_event(event_id):
            """캘린더 일정 삭제 (멱등적: 404는 already_deleted로 OK 처리).

            Body: {"calendar_id": "..."} — 어느 캘린더의 이벤트인지 명시.
            """
            # 1) 토큰 검증
            token = request.headers.get("X-Internal-Token")
            if not token or token != self.config.internal_api_token:
                self.logger.warning(
                    f"인증 실패 (DELETE, X-Internal-Token 불일치): "
                    f"remote={request.remote_addr}"
                )
                return jsonify({"ok": False, "error": "Unauthorized"}), 401

            # 2) Body 파싱 (calendar_id)
            try:
                data = request.get_json(force=True, silent=True) or {}
            except Exception:
                data = {}
            calendar_id = (
                data.get("calendar_id") if isinstance(data, dict) else None
            ) or self.config.write_target_id

            if not event_id:
                return jsonify({"ok": False, "error": "event_id required"}), 400

            # 3) Google Calendar API 삭제 (404는 멱등적 처리)
            try:
                self.client.service.events().delete(
                    calendarId=calendar_id, eventId=event_id
                ).execute()
                self.logger.info(
                    f"캘린더 일정 삭제 완료: calendar_id={calendar_id}, "
                    f"eventId={event_id}"
                )
                return jsonify({"ok": True}), 200
            except Exception as e:
                err = str(e)
                # 이미 삭제됐거나 없는 경우는 OK로 처리 (멱등성)
                if "404" in err or "Resource has been deleted" in err or "Not Found" in err:
                    self.logger.info(
                        f"캘린더 일정 이미 삭제됨 (멱등 처리): "
                        f"eventId={event_id}"
                    )
                    return jsonify({"ok": True, "note": "already_deleted"}), 200
                self.logger.exception(f"캘린더 일정 삭제 실패: {e}")
                return jsonify({"ok": False, "error": err}), 500

        return app

    def _match_category(
        self,
        summary: str,
        keyword_rules: list[dict],
        default_category_id: int,
        default_category_code: str,
    ) -> tuple[int, str, str | None]:
        """제목 키워드로 카테고리 판정.

        priority 오름차순으로 순회하면서 첫 매칭 룰 사용.
        매칭 안 되면 default (캘린더의 default_category) 반환.

        반환: (category_id, category_code, matched_keyword_or_None)
        """
        if not summary:
            return default_category_id, default_category_code, None

        for rule in keyword_rules:  # 이미 priority 오름차순 정렬됨
            if rule["keyword"] in summary:
                return rule["category_id"], rule["category_code"], rule["keyword"]

        return default_category_id, default_category_code, None

    def _fetch_kasi_holidays(self, service_key, year, month):
        """getRestDeInfo 1개월 조회 → {'YYYY-MM-DD': 명칭} (isHoliday='Y'만).
           실패(HTTP/파싱/resultCode!=00)는 예외로 올린다(상위가 '이 달 스킵' 처리)."""
        base = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo"
        params = {
            "serviceKey": service_key,
            "pageNo": 1, "numOfRows": 50,
            "solYear": year, "solMonth": f"{month:02d}",
            "_type": "json",
        }
        # 일시적 오류 대비 2회까지 재시도
        last_err = None
        for attempt in range(2):
            try:
                resp = requests.get(base, params=params, timeout=10)
                resp.raise_for_status()
                data = resp.json()
                header = (data.get("response") or {}).get("header") or {}
                if header.get("resultCode") != "00":
                    raise RuntimeError(
                        f"KASI resultCode={header.get('resultCode')} {header.get('resultMsg')}"
                    )
                items = ((data["response"].get("body") or {}).get("items"))
                result = {}
                if items and items != "":   # 빈 문자열이면 공휴일 0건
                    item = items.get("item")
                    rows = item if isinstance(item, list) else [item]
                    for r in rows:
                        if str(r.get("isHoliday", "")).strip().upper() == "Y":
                            s = str(r["locdate"])  # 20260815
                            ymd = f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
                            result[ymd] = r.get("dateName", "")
                return result
            except Exception as e:
                last_err = e
                time.sleep(1)
        raise last_err

    def _sync_holidays(self, now_kst: datetime) -> None:
        """KASI 특일정보 API(getRestDeInfo)로 hr.holidays reconcile.

        - 올해 1월 ~ 내년 12월(24개월)을 월 단위로 조회.
        - 조회 성공한 달만 reconcile_month_holidays 호출 (실패 달은 기존 유지).
        - source != 'manual' 행만 KASI 실제 공휴일로 정확히 맞춘다(reconcile).
        - 직원 매칭/attendance_request INSERT는 하지 않음 (근태와 분리).
        """
        service_key = os.environ.get("KASI_SERVICE_KEY")
        if not service_key:
            self.logger.warning("KASI_SERVICE_KEY 미설정 → 공휴일 동기화 skip")
            return
        this_year = now_kst.year
        total_up = total_del = total_skip = 0
        for year in (this_year, this_year + 1):
            for month in range(1, 13):
                try:
                    fresh = self._fetch_kasi_holidays(service_key, year, month)
                except Exception as e:
                    total_skip += 1
                    self.logger.warning(
                        f"공휴일 조회 실패 {year}-{month:02d}: {e} → 이 달 기존 유지"
                    )
                    continue
                up, deleted = self.db.reconcile_month_holidays(year, month, fresh)
                total_up += up
                total_del += deleted
        self.logger.info(
            f"공휴일 동기화(KASI): upsert {total_up} / 삭제 {total_del} / "
            f"스킵 {total_skip}개월"
        )

    def sync_holidays(self):
        """공휴일 동기화(KASI) 1회. 실패해도 예외를 올리지 않는다(근태 동기화와 분리)."""
        try:
            self._sync_holidays(datetime.now(KST))
        except Exception as e:
            self.logger.exception(f"공휴일 동기화 실패 (계속 진행): {e}")

    def sync_interval_minutes(self) -> int:
        """일정 동기화 주기(분) — 매 루프 다시 읽는다. 조회 실패면 기본값."""
        try:
            raw = self.db.get_policy("calendar_sync_interval_minutes")
        except Exception as e:
            self.logger.warning(f"calendar_sync_interval_minutes 조회 실패 (기본값 사용): {e}")
            raw = None
        return resolve_sync_interval(raw)

    def events_sync_due(self, now_kst: datetime) -> bool:
        """마지막 일정 동기화 시작에서 N분이 지났으면 True."""
        if self.last_events_sync_at is None:
            return True
        interval = self.sync_interval_minutes()
        return now_kst - self.last_events_sync_at >= timedelta(minutes=interval)

    def sync_events(self, now_kst: Optional[datetime] = None):
        """일정 동기화 1회: 캘린더 일정 → google_calendar 신청 행 업서트 → 빠진 기록 정리."""
        cycle_start = time.time()
        now_kst = now_kst or datetime.now(KST)
        self.last_events_sync_at = now_kst
        today = now_kst.date()  # KST 달력 날짜 — SQL 에는 파라미터로 넘긴다

        # 읽기 범위: 오늘 00:00 ~ 23:59:59 KST (당일만)
        time_min = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
        time_max = now_kst.replace(hour=23, minute=59, second=59, microsecond=0)

        email_map = self.db.get_employee_email_map()
        cat_types = self.db.get_category_types()

        try:
            calendar_sources = self.db.get_calendar_sources()
        except Exception as e:
            self.logger.exception(f"calendar_sources 조회 실패 (정리 생략): {e}")
            return
        if not calendar_sources:
            self.logger.warning("calendar_sources에 등록된 캘린더 없음 (sync_enabled=true 0건)")
            return

        counts = {
            "created": 0, "updated": 0, "revived": 0, "unchanged": 0,
            "skipped_hr_overlap": 0, "kept_cancelled": 0, "conflict": 0, "error": 0,
        }
        events_total = 0
        seen: set = set()        # 이번 사이클에 대상이 된 (event_id, employee_id)
        uncertain: set = set()   # 날짜·시간 파싱 실패 event_id — 그 행은 정리하지 않는다
        failed_calendars: list[str] = []

        for cs in calendar_sources:
            cs_id = cs["id"]
            cal_name = cs["calendar_name"]
            try:
                keyword_rules = self.db.get_keyword_rules(cs_id)
            except Exception as e:
                self.logger.warning(f"  [{cal_name}] keyword_rules 조회 실패 (default만 사용): {e}")
                keyword_rules = []

            try:
                events = self.client.list_events(cs["calendar_id"], time_min, time_max)
            except Exception as e:
                # 페이지 도중 예외 포함 — 이번 사이클은 불완전 → 정리하지 않는다
                self.logger.warning(f"  [{cal_name}] 일정 조회 실패 (이번 사이클 정리 생략): {e}")
                failed_calendars.append(cal_name)
                continue

            for event in events:
                p = self.client.parse_event(event)
                event_id = event.get("id")

                # 시스템 생성분은 스킵 (무한루프 방지)
                # - vanam_source(extendedProperties): 정상 경로로 만든 신규 이벤트
                # - description 태그: vanam_source가 없는 과거 생성 이벤트까지 커버
                _desc = event.get("description") or ""
                if p["ext_props"].get("vanam_source") or "[VanaM HR 자동 등록]" in _desc:
                    self.logger.debug(f"  [{cal_name}] [SKIP-시스템생성] {p['summary']}")
                    continue
                events_total += 1

                target_emails = select_target_emails(p, email_map)
                emp_ids = []
                for email in target_emails:
                    emp_id = email_map.get(email)
                    if emp_id:
                        emp_ids.append(emp_id)
                        seen.add((event_id, emp_id))
                self.logger.debug(
                    f"  [{cal_name}] {p['summary']} | creator={p['creator_email'] or '-'} "
                    f"| 대상 {target_emails} → emp {emp_ids}"
                )

                cat_id, cat_code, matched_kw = self._match_category(
                    p["summary"], keyword_rules,
                    cs["default_category_id"], cs["default_category_code"],
                )
                if not cat_id:
                    self.logger.debug(f"  [{cal_name}] {p['summary']} → 스킵 (cat 없음)")
                    continue

                try:
                    start_d, end_d, ci, co = parse_event_times(event, p)
                except Exception as e:
                    uncertain.add(event_id)
                    self.logger.warning(
                        f"  [{cal_name}] 날짜/시간 파싱 실패 event={event_id} "
                        f"'{p['summary']}': {e} (이 일정의 기록은 정리하지 않음)"
                    )
                    continue

                new = {
                    "category_id": cat_id,
                    "start_date": start_d,
                    "end_date": end_d,
                    "reason": p["summary"],
                    "ci": ci,
                    "co": co,
                }
                for emp_id in emp_ids:
                    try:
                        res = apply_event_for_employee(
                            self.db, emp_id, event_id, new, today, cat_types
                        )
                    except Exception as e:
                        counts["error"] += 1
                        self.logger.exception(
                            f"  [{cal_name}] 업서트 실패 (emp={emp_id}, event={event_id}): {e}"
                        )
                        continue
                    kind = res["kind"]
                    counts[kind] += 1
                    self._log_upsert_result(cal_name, p["summary"], emp_id, cat_code, matched_kw, res)

        # 정리 — 모든 캘린더 조회에 성공한 사이클에서만
        cleanup = {"cancelled": 0, "shortened": 0, "conflict": 0}
        if failed_calendars:
            self.logger.info(
                f"  [정리] 생략 — 조회 실패 캘린더 {failed_calendars} (불완전 사이클)"
            )
        else:
            cleanup = self._cleanup_missing(today, seen, uncertain, set(email_map.values()), cat_types)

        elapsed = time.time() - cycle_start
        self.logger.info(
            f"=== 일정 동기화 {today} {elapsed:.2f}s — 일정 {events_total}건, "
            f"신규 {counts['created']} / 갱신 {counts['updated']} / 되살림 {counts['revived']} / "
            f"변경없음 {counts['unchanged']} / HR겹침 {counts['skipped_hr_overlap']} / "
            f"취소유지 {counts['kept_cancelled']} / 충돌 {counts['conflict']} / 오류 {counts['error']}, "
            f"정리 취소 {cleanup['cancelled']} / 단축 {cleanup['shortened']}"
            f"{' (정리 생략)' if failed_calendars else ''} ==="
        )

    def _log_upsert_result(self, cal_name, summary, emp_id, cat_code, matched_kw, res):
        """변경(신규·갱신·되살림)은 info, 매 사이클 반복되는 결과는 debug."""
        kind = res["kind"]
        old, new = res["old"], res["new"]
        cat_label = f"{cat_code}({'키워드:' + matched_kw if matched_kw else 'default'})"
        rid = res["request_id"]
        if kind == "created":
            self.logger.info(
                f"  [{cal_name}] 신규 req#{rid} emp={emp_id} '{summary}' {cat_label} "
                f"{new['start']}~{new['end']}"
            )
        elif kind in ("updated", "revived"):
            label = "갱신" if kind == "updated" else "되살림(캘린더에 다시 보임)"
            self.logger.info(
                f"  [{cal_name}] {label} req#{rid} emp={emp_id} '{summary}' "
                f"{old['start']}~{old['end']} cat={old['category_id']} → "
                f"{new['start']}~{new['end']} cat={new['category_id']}"
            )
        elif kind == "conflict":
            self.logger.info(
                f"  [{cal_name}] 건너뜀 req#{rid} emp={emp_id} — 읽은 뒤 상태가 바뀜(웹 취소 등)"
            )
        else:
            reason = {
                "unchanged": "변경 없음",
                "skipped_hr_overlap": "HR 신청과 같은 카테고리·기간 겹침 → 만들지/되살리지 않음",
                "kept_cancelled": "사람 취소·이전 취소 → 유지",
            }.get(kind, kind)
            self.logger.debug(f"  [{cal_name}] req#{rid or '-'} emp={emp_id} '{summary}' — {reason}")

    def _cleanup_missing(self, today, seen, uncertain, target_employee_ids, cat_types) -> dict:
        """캘린더에서 빠진 기록 정리 (사이클당 1번). 계획을 다 세운 뒤 상한을 넘으면 아무것도 안 한다."""
        empty = {"cancelled": 0, "shortened": 0, "conflict": 0}
        try:
            rows = self.db.list_live_calendar_requests_covering(today)
            plan = plan_cleanup(
                rows, seen, uncertain, today, target_employee_ids, self.db.has_trip_report
            )
        except Exception as e:
            self.logger.exception(f"  [정리] 계획 실패 (생략): {e}")
            return empty

        for r in plan["trip_blocked"]:
            if self._trip_report_warned.get(r["id"]) != today:
                self._trip_report_warned[r["id"]] = today
                self.logger.warning(
                    f"  [정리] 취소 보류 req#{r['id']} emp={r['employee_id']} "
                    f"event={r['external_event_id']} — 출장보고서가 있어 취소하지 않음"
                )

        if plan["total"] > CLEANUP_SAFETY_CAP:
            self.logger.warning(
                f"  [정리] 대상 {plan['total']}건(취소 {len(plan['cancels'])} / 단축 "
                f"{len(plan['shortens'])})이 상한 {CLEANUP_SAFETY_CAP} 초과 → 아무것도 하지 않음. "
                f"대상 req: {[r['id'] for r in plan['cancels'] + plan['shortens']]}"
            )
            return empty
        if plan["total"] == 0:
            return empty
        return execute_cleanup(self.db, plan, today, cat_types, self.logger)

    def purge_old_data(self):
        """데이터 보관기간 정리. PURGE_ENABLED=False면 대상 건수만 로그(dry-run).

        5개 대상을 각각 독립된 try/except로 처리해 하나가 실패해도 나머지는 계속.
        각 대상 공통 흐름:
          1) count → (건수, 범위시작, 범위끝)
          2) 대상 로그
          3) 건수 0 → skip
          4) dry-run(PURGE_ENABLED=False) → 삭제 생략
          5) 안전상한 초과 → 삭제 중단(버그 의심)
          6) 모두 통과 → 실제 delete 후 결과 로그
        """
        dry_run = not PURGE_ENABLED
        self.logger.info(
            f"=== [PURGE] 데이터 보관기간 정리 시작 (dry_run={dry_run}) ==="
        )

        def _process(label, count_fn, delete_fn, retention, cap):
            try:
                cnt, range_start, range_end = count_fn(retention)
                cnt = cnt or 0
                self.logger.info(
                    f"[PURGE] {label}: 대상 {cnt}건, "
                    f"범위 {range_start}~{range_end}, 보관기간 {retention}"
                )
                if cnt == 0:
                    return
                if not PURGE_ENABLED:
                    self.logger.info(f"[PURGE] {label}: dry-run 모드라 실제 삭제 생략")
                    return
                if cnt > cap:
                    self.logger.warning(
                        f"[PURGE] {label}: 대상 {cnt}건이 안전상한 {cap} 초과 "
                        f"→ 삭제 중단(버그 의심)"
                    )
                    return
                deleted = delete_fn(retention)
                self.logger.info(f"[PURGE] {label}: 실제 삭제 완료 {deleted}건")
            except Exception as e:
                self.logger.exception(f"[PURGE] {label}: 처리 실패 (계속 진행): {e}")

        _process(
            "presence_raw",
            self.db.count_old_presence_raw,
            self.db.delete_old_presence_raw,
            PRESENCE_RAW_RETENTION,
            PURGE_SAFETY_CAP_PRESENCE_RAW,
        )
        _process(
            "attendance_daily(미확정)",
            self.db.count_old_attendance_daily_unconfirmed,
            self.db.delete_old_attendance_daily_unconfirmed,
            ATTENDANCE_DAILY_UNCONFIRMED_RETENTION,
            PURGE_SAFETY_CAP_DEFAULT,
        )
        _process(
            "attendance_daily(확정)",
            self.db.count_old_attendance_daily_confirmed,
            self.db.delete_old_attendance_daily_confirmed,
            ATTENDANCE_DAILY_CONFIRMED_RETENTION,
            PURGE_SAFETY_CAP_DEFAULT,
        )
        _process(
            "attendance_requests",
            self.db.count_old_attendance_requests,
            self.db.delete_old_attendance_requests,
            ATTENDANCE_REQUESTS_RETENTION,
            PURGE_SAFETY_CAP_DEFAULT,
        )
        _process(
            "monthly_confirmations",
            self.db.count_old_monthly_confirmations,
            self.db.delete_old_monthly_confirmations,
            MONTHLY_CONFIRMATIONS_RETENTION,
            PURGE_SAFETY_CAP_DEFAULT,
        )

        self.logger.info("=== [PURGE] 데이터 보관기간 정리 종료 ===")

    def _should_run_now(self, now_kst: datetime) -> bool:
        """공휴일·purge: 지금이 실행 시각(RUN_HOUR)이고, 오늘 아직 안 돌았으면 True."""
        if now_kst.hour != RUN_HOUR:
            return False
        # 같은 날 중복 방지
        today = now_kst.date()
        if self.last_run_date == today:
            return False
        return True

    def run_loop_once(self, now_kst: datetime) -> None:
        """메인 루프 한 번 — 04:00 공휴일·purge, N분마다 일정 동기화."""
        if self._should_run_now(now_kst):
            self.logger.info(
                f"공휴일·purge 실행 시각 도달 ({now_kst.strftime('%Y-%m-%d %H:%M:%S')} KST)"
            )
            self.sync_holidays()
            try:
                self.purge_old_data()
            except Exception as e:
                self.logger.exception(f"[PURGE] purge_old_data 예외 (계속 진행): {e}")
            self.last_run_date = now_kst.date()

        if self.events_sync_due(now_kst):
            try:
                self.sync_events(now_kst)
            except Exception as e:
                self.logger.exception(f"sync_events 예외 (계속 진행): {e}")

    def run(self):
        """메인 루프.

        - HTTP 서버를 별도 스레드(daemon)로 먼저 시작 (재고관리 연동용)
        - 부팅 직후: 공휴일 1번 + 일정 동기화 1번
        - 그 후 매 60초마다 깨어나서 04:00(공휴일·purge)과 일정 동기화 주기 체크
        """
        # HTTP 서버를 별도 스레드로 시작 (데몬 스레드, 메인 종료 시 함께 종료)
        # threaded=True: Flask 기본은 single-threaded, 동시 요청 처리 위해 활성화
        self.http_thread = threading.Thread(
            target=lambda: self.http_app.run(
                host="0.0.0.0",
                port=self.config.http_port,
                debug=False,
                use_reloader=False,
                threaded=True,
            ),
            daemon=True,
            name="HttpServer",
        )
        self.http_thread.start()
        self.logger.info(
            f"HTTP 서버 시작 (포트 {self.config.http_port}, 내부망 전용)"
        )

        # 부팅 직후: 공휴일 1번 + 일정 동기화 1번
        self.logger.info("부팅 직후 공휴일 1번 + 일정 동기화 1번")
        self.sync_holidays()
        self.last_run_date = datetime.now(KST).date()
        try:
            self.sync_events()
        except Exception as e:
            self.logger.exception(f"초기 sync_events 예외 (계속 진행): {e}")

        while self.running:
            self.run_loop_once(datetime.now(KST))

            if not self.running:
                break

            # 1초 단위로 끊어 자며 종료 신호에 빠르게 반응
            slept = 0
            while self.running and slept < CHECK_INTERVAL_SECONDS:
                time.sleep(1)
                slept += 1

        self.logger.info("Calendar Syncer 정상 종료")

    def stop(self, signum, frame):
        self.logger.info(f"종료 신호 수신 ({signum})")
        self.running = False


def main():
    syncer = Syncer()
    signal.signal(signal.SIGTERM, syncer.stop)
    signal.signal(signal.SIGINT, syncer.stop)
    try:
        syncer.run()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
