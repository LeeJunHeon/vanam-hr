"""Google Calendar 동기화 데몬 (Phase 6 2-A — 카테고리 판정 로그) + 캘린더 쓰기 endpoint.

흐름:
1. config 로드 → logger 셋업 → 시작 로그
2. DB 연결
3. CalendarClient 인증 (도메인 위임)
4. Flask HTTP 서버를 별도 스레드로 시작 (내부망 전용)
   - POST /internal/calendar-event: 재고관리 등 내부 시스템이 일정 등록
   - GET  /internal/health: liveness 체크
5. 메인 루프:
   - 매일 04:00 KST에 sync_once 1회 실행
   - 부팅 직후 1회 즉시 실행 (검증 편의)
   - DB의 calendar_sources (sync_enabled=true) 동적 조회
   - 당일 일정만 읽기
   - 키워드 매칭으로 카테고리 판정 (priority 오름차순, 첫 매칭 사용)
   - 매칭 안 되면 default_category 사용
   - 결과를 로그로만 출력 (DB INSERT 안 함, Phase 6-2B에서 추가)

체크 주기: 60초 (분 단위로 04:00 도달 감지). CPU 부담 거의 없음.
"""

import os
import signal
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

import requests
from flask import Flask, jsonify, request

from config import load_config
from db import Database
from logger import setup_logger
from calendar_client import CalendarClient

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
        self.last_run_date = None  # 같은 날 중복 실행 방지

        self.logger.info("Calendar Syncer 시작 (Phase 6 2-A — 카테고리 판정 로그)")
        self.logger.info(
            f"실행 시각: 매일 {RUN_HOUR:02d}:{RUN_MINUTE:02d} KST, "
            f"SUBJECT={self.config.subject_email}"
        )

        # DB 연결
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
        """Flask 앱 생성. /internal/calendar-event(POST/DELETE) + /internal/health.

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

    def sync_once(self):
        """1회 실행: DB에서 캘린더 목록 읽고 → 일정 조회 → 카테고리 판정 로그."""
        cycle_start = time.time()

        # 읽기 범위: 오늘 00:00 ~ 23:59:59 KST (당일만)
        now_kst = datetime.now(KST)
        time_min = now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
        time_max = now_kst.replace(hour=23, minute=59, second=59, microsecond=0)

        self.logger.info(
            f"=== 동기화 사이클 시작 (당일: {time_min.date()}) ==="
        )

        # 직원 매칭 맵 갱신
        email_map = self.db.get_employee_email_map()
        self.logger.info(f"직원 {len(email_map)}명 매칭 맵 로드")

        # Phase 6-2L+ B-2: 공휴일 캘린더 → hr.holidays 동기화 (1회)
        # 근태 캘린더와 독립. 실패해도 근태 동기화에 영향 없도록 try/except로 격리.
        # 직원 매칭/attendance_request INSERT는 절대 하지 않는다(공휴일은 근태 요청 아님).
        try:
            self._sync_holidays(now_kst)
        except Exception as e:
            self.logger.exception(f"공휴일 동기화 실패 (계속 진행): {e}")

        # 동기화 대상 캘린더 목록 (DB 동적 조회)
        try:
            calendar_sources = self.db.get_calendar_sources()
        except Exception as e:
            self.logger.exception(f"calendar_sources 조회 실패: {e}")
            return

        if not calendar_sources:
            self.logger.warning("calendar_sources에 등록된 캘린더 없음 (sync_enabled=true 0건)")
            return

        self.logger.info(f"동기화 대상 캘린더: {len(calendar_sources)}개")

        # 캘린더별 처리
        grand_all_day = 0
        grand_timed = 0
        grand_matched = 0

        for cs in calendar_sources:
            cs_id = cs["id"]
            cal_name = cs["calendar_name"]
            cal_id = cs["calendar_id"]
            default_cat_id = cs["default_category_id"]
            default_cat_code = cs["default_category_code"]

            # 이 캘린더에 적용되는 키워드 룰 로드 (priority 오름차순)
            try:
                keyword_rules = self.db.get_keyword_rules(cs_id)
            except Exception as e:
                self.logger.warning(f"  [{cal_name}] keyword_rules 조회 실패 (default만 사용): {e}")
                keyword_rules = []

            self.logger.info(
                f"  [{cal_name}] default={default_cat_code}, "
                f"키워드 룰 {len(keyword_rules)}개"
            )

            # 일정 조회
            try:
                events = self.client.list_events(cal_id, time_min, time_max)
            except Exception as e:
                self.logger.warning(f"  [{cal_name}] 일정 조회 실패: {e}")
                continue

            all_day_cnt = 0
            timed_cnt = 0
            matched_cnt = 0

            for event in events:
                p = self.client.parse_event(event)

                # 시스템 생성분은 스킵 (무한루프 방지)
                # - vanam_source(extendedProperties): 정상 경로로 만든 신규 이벤트
                # - description 태그: vanam_source가 없는 과거 생성 이벤트까지 커버
                _desc = event.get("description") or ""
                if p["ext_props"].get("vanam_source") or "[VanaM HR 자동 등록]" in _desc:
                    self.logger.info(
                        f"  [{cal_name}] [SKIP-시스템생성] {p['summary']}"
                    )
                    continue

                if p["is_all_day"]:
                    all_day_cnt += 1
                    when_label = f"종일 {p['start_date_or_datetime']}"
                else:
                    timed_cnt += 1
                    when_label = f"시간 {p['start_date_or_datetime']}"

                # 카테고리 판정 (일정 단위 1회 — 모든 직원에게 공통 적용)
                cat_id, cat_code, matched_kw = self._match_category(
                    p["summary"], keyword_rules, default_cat_id, default_cat_code
                )
                if matched_kw:
                    cat_label = f"category={cat_code} (키워드:{matched_kw})"
                else:
                    cat_label = f"category={cat_code} (default)"

                # 처리 대상 이메일 집합 — accepted 참석자만 (없으면 creator)
                # - creator: accepted 참석자가 한 명도 없을 때만 대상에 포함
                # - 참석자: response_status='accepted'만 (declined/needsAction/tentative 제외)
                creator = p["creator_email"]
                target_emails: set[str] = set()
                accepted_count = 0
                for a in p.get("attendees") or []:
                    email = a.get("email")
                    if a.get("response_status") == "accepted" and email:
                        target_emails.add(email.lower().strip())
                        accepted_count += 1
                # 참석자(accepted)가 한 명도 없을 때만 생성자를 출장/외근 대상으로 처리
                if accepted_count == 0 and creator:
                    target_emails.add(creator.lower().strip())

                # 카테고리 없으면 아무도 처리 안 함
                if not cat_id:
                    self.logger.info(
                        f"  [{cal_name}] {when_label} | {p['summary']} "
                        f"| creator={creator or '-'} | 대상 {len(target_emails)}명 "
                        f"(accepted {accepted_count}) | {cat_label} → 스킵 (cat 없음)"
                    )
                    continue

                # 날짜/시간 계산 (일정 단위 1회 — 모든 직원에게 공통)
                try:
                    end_raw = (event.get("end") or {})
                    if p["is_all_day"]:
                        # 종일: start.date / end.date (end.date는 Google API exclusive=다음날)
                        start_date_str = p["start_date_or_datetime"]  # "YYYY-MM-DD"
                        end_exclusive = end_raw.get("date")
                        if end_exclusive:
                            end_dt_obj = datetime.strptime(
                                end_exclusive, "%Y-%m-%d"
                            ).date()
                            end_date_str = (
                                end_dt_obj - timedelta(days=1)
                            ).strftime("%Y-%m-%d")
                        else:
                            end_date_str = start_date_str
                        corrected_check_in = None
                        corrected_check_out = None
                    else:
                        # 시간 지정: start.dateTime / end.dateTime (ISO 문자열, TZ 포함)
                        start_iso = p["start_date_or_datetime"]
                        end_iso = end_raw.get("dateTime")
                        if not end_iso:
                            raise ValueError("end.dateTime 없음")
                        # Python 3.11+은 Z 직접 지원하나 안전하게 +00:00로 치환
                        start_dt_obj = datetime.fromisoformat(
                            start_iso.replace("Z", "+00:00")
                        )
                        end_dt_obj = datetime.fromisoformat(
                            end_iso.replace("Z", "+00:00")
                        )
                        start_date_str = start_dt_obj.strftime("%Y-%m-%d")
                        end_date_str = end_dt_obj.strftime("%Y-%m-%d")
                        corrected_check_in = start_dt_obj
                        corrected_check_out = end_dt_obj
                except Exception as e:
                    self.logger.exception(
                        f"  [{cal_name}] 날짜/시간 파싱 실패: {e}"
                    )
                    continue

                # ⭐ 직원별 attendance_request UPSERT
                # 같은 일정이라도 직원마다 1행. DB UNIQUE는 (external_source,
                # external_event_id, employee_id)이므로 중복 없이 직원별 갱신.
                per_event_matched = 0
                per_event_results: list[str] = []
                for email in sorted(target_emails):
                    emp_id = email_map.get(email)
                    if not emp_id:
                        per_event_results.append(f"{email}: 매칭 안 됨")
                        continue
                    try:
                        request_id = self.db.upsert_attendance_request(
                            employee_id=emp_id,
                            category_id=cat_id,
                            start_date=start_date_str,
                            end_date=end_date_str,
                            external_event_id=event["id"],
                            reason=p["summary"],
                            corrected_check_in=corrected_check_in,
                            corrected_check_out=corrected_check_out,
                        )
                        per_event_matched += 1
                        per_event_results.append(
                            f"emp={emp_id}({email}) → req#{request_id} ✅"
                        )
                    except Exception as e:
                        self.logger.exception(
                            f"  [{cal_name}] UPSERT 실패 (emp={emp_id}, email={email}): {e}"
                        )
                        per_event_results.append(
                            f"emp={emp_id}({email}) → UPSERT 실패 ❌"
                        )

                matched_cnt += per_event_matched

                self.logger.info(
                    f"  [{cal_name}] {when_label} | {p['summary']} "
                    f"| creator={creator or '-'} | 대상 {len(target_emails)}명 "
                    f"(accepted {accepted_count}) | {cat_label} | 매칭 {per_event_matched}건"
                )
                for entry in per_event_results:
                    self.logger.info(f"  [{cal_name}]   - {entry}")

            self.logger.info(
                f"  [{cal_name}] 요약 — 종일 {all_day_cnt}건 / "
                f"시간지정 {timed_cnt}건 / 직원매칭 {matched_cnt}건"
            )

            grand_all_day += all_day_cnt
            grand_timed += timed_cnt
            grand_matched += matched_cnt

        elapsed = time.time() - cycle_start
        self.logger.info(
            f"=== 사이클 종료: {elapsed:.2f}s "
            f"(전체 종일 {grand_all_day} / 시간지정 {grand_timed} / 매칭 {grand_matched}) ==="
        )

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
        """지금이 실행 시각(RUN_HOUR:RUN_MINUTE)이고, 오늘 아직 안 돌았으면 True."""
        if now_kst.hour != RUN_HOUR:
            return False
        # 같은 날 중복 방지
        today = now_kst.date()
        if self.last_run_date == today:
            return False
        return True

    def run(self):
        """메인 루프.

        - HTTP 서버를 별도 스레드(daemon)로 먼저 시작 (재고관리 연동용)
        - 부팅 직후 1회 즉시 sync_once 실행 (검증 편의)
        - 그 후 매 60초마다 깨어나서 04:00 도달 체크
        - 04:00이면 sync_once 실행, last_run_date 갱신
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

        # 부팅 즉시 1회 실행 (검증/디버깅 편의)
        try:
            self.logger.info("부팅 직후 즉시 1회 실행 (검증용)")
            self.sync_once()
            self.last_run_date = datetime.now(KST).date()
        except Exception as e:
            self.logger.exception(f"초기 sync_once 예외 (계속 진행): {e}")

        # 메인 루프: 1분마다 깨어나서 04:00 체크
        while self.running:
            now_kst = datetime.now(KST)
            if self._should_run_now(now_kst):
                self.logger.info(
                    f"실행 시각 도달 ({now_kst.strftime('%Y-%m-%d %H:%M:%S')} KST)"
                )
                try:
                    self.sync_once()
                except Exception as e:
                    self.logger.exception(f"sync_once 예외 (계속 진행): {e}")
                try:
                    self.purge_old_data()
                except Exception as e:
                    self.logger.exception(f"[PURGE] purge_old_data 예외 (계속 진행): {e}")
                self.last_run_date = now_kst.date()

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
