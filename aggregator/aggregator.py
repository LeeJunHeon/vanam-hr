"""presence_raw → attendance_daily 변환 데몬 (메인 entry point).

매 60초마다 활성 직원 각각의 오늘+어제 work_date presence_raw를 분석해
출퇴근 시각을 계산하고 attendance_daily에 UPSERT.
is_overridden=true 인 row는 건드리지 않음.

출퇴근 정의 (employee 단위 통합 timeline, location 무관):
- 출근: 그날 첫 'online'의 checked_at
- 퇴근: 마지막 record가 offline이고 그 후 grace 동안 재연결 없을 때만 확정
  1) 마지막=offline + grace 경과 → 그 offline 시각이 퇴근 (정상)
  2) 마지막=offline + grace 미경과 → None (잠깐 자리 비움, 근무중 유지)
  3) 마지막=online → None (자리에 있음, 근무중)
     ※ poller는 상태 전환 시에만 INSERT하므로 침묵은 "online 유지" 의미.
       가만히 있는 사람을 퇴근 처리하지 않는다.
- grace_minutes는 hr.policy_settings.debounce_minutes에서 읽음 (기본 60)
- 새벽 cutoff(4시) 전 재online은 work_date 귀속 + UPSERT로 자동 취소됨
  (퇴근 확정 후 야간 재방문 시 working으로 자동 복원)
- auto_status: 시프트 매칭 후 정책 A 판정 (지각/조퇴 정교화)
- 시프트 없음 또는 휴무: 단순 (normal/working/absent/None)
- 시프트 있음:
  - check_in > 시프트시작 + grace_in_minutes → 'late'
  - 근무시간 < 시프트시간 - grace_out_minutes → 'early_leave'
  - 그 외 둘 다 있음 → 'normal'
  - 둘 다 없음 → 'absent'
  - check_in만 있음 → 'working' (근무중)
  - check_out만 있음 → None (판정 보류)
- grace_in_minutes는 hr.policy_settings (기본 10)
- grace_out_minutes는 hr.policy_settings (기본 0)

work_date 귀속 (야간 근무자 정책):
- 새벽 cutoff_hour 시 이전 활동은 전일 work_date로 귀속
- cutoff_hour는 hr.policy_settings.work_date_cutoff_hour 에서 읽음 (기본 4)
- 예: 5/27 03:30 활동 → work_date=5/26 (어제 야간 시프트의 연장)
- aggregator는 매 사이클마다 어제+오늘 두 work_date 모두 처리하여
  04:00~05:00 사이 grace 60분 도달 시점도 정확히 잡힌다.

sync 단순 루프. asyncio 의존성 없음.
"""

import signal
import sys
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

from config import load_config
from db import Database
from logger import setup_logger
from notifier import EmailNotifier

# 한국 시간대 (UTC+9, DST 없음) — 끊김 알림에서 KST 비교용
KST = timezone(timedelta(hours=9))


class Aggregator:
    def __init__(self):
        self.config = load_config()
        self.logger = setup_logger(self.config.log_level, self.config.log_file)
        self.db = Database(
            host=self.config.db_host,
            port=self.config.db_port,
            dbname=self.config.db_name,
            user=self.config.db_user,
            password=self.config.db_password,
        )
        self.running = True
        # 근무중 끊김 알림 메일 발송기 (SMTP 미설정이면 발송 스킵)
        self.notifier = EmailNotifier(
            self.config.smtp_host,
            self.config.smtp_port,
            self.config.smtp_user,
            self.config.smtp_password,
            self.config.smtp_from,
            self.logger,
        )
        # 끊김 알림 중복 발송 방지용 메모리 상태: {emp_id: "YYYY-MM-DD"}
        # - 끊김이면 오늘 날짜 기록(이미 같은 날짜면 재발송 X)
        # - 연결 복귀 시 해당 emp 제거 → 다시 끊기면 같은 날에도 재발송
        # - 날짜가 바뀌면 기록값이 오늘과 달라 자동으로 재발송 허용
        self._disconnect_notified: dict[int, str] = {}

    def compute_check_in_out(
        self,
        raw_records: list[dict],
        grace_minutes: int,
        now: datetime,
    ) -> tuple[Optional[datetime], Optional[datetime]]:
        """raw_records를 분석해 (check_in, check_out) 반환.

        employee 단위 통합 timeline (location 무관).

        규칙:
        - check_in: 그날 첫 'online'의 checked_at
        - check_out:
          1) 마지막 record가 offline + grace 경과 → 그 offline 시각 (정상 퇴근 확정)
             예: 09:18 online → ... → 18:30 offline (지금이 19:31+) → check_out = 18:30
          2) 마지막 record가 offline + grace 미경과 → None (잠깐 자리 비움, 근무중)
             예: 12:00 offline (지금이 12:30) → 점심 외출 가능성 → 근무중 유지
          3) 마지막 record가 online → None (자리에 있음, 근무중)
             예: poller가 "상태 전환 시에만 INSERT"하는 설계이므로, 가만히 online
                  유지인 사람은 presence_raw에 추가 INSERT가 없다 (정상).
                  이 침묵을 폴러 장애로 오해해서 퇴근 처리하면 안 됨.

        새벽 cutoff(4시) 전 재online은 work_date 귀속 + UPSERT 메커니즘으로 자동 처리:
        - 4시 이전 활동은 전일 work_date에 귀속
        - aggregate_today가 매 사이클 어제+오늘 두 work_date 모두 재처리
        - 이전에 퇴근 확정됐어도 새 online이 들어오면 마지막 record가 online으로 바뀌어
          자동으로 working으로 되돌아감 (is_overridden=true 제외).

        raw_records는 checked_at 오름차순 정렬되어 있어야 함.
        now는 timezone-aware datetime (UTC 권장).
        """
        if not raw_records:
            return None, None

        # 첫 online → check_in
        check_in = None
        for r in raw_records:
            if r["status"] == "online":
                check_in = r["checked_at"]
                break

        # 마지막 record 확인
        last_record = raw_records[-1]
        check_out = None

        if last_record["status"] == "offline":
            # 마지막이 offline → grace 경과 후에만 퇴근 확정
            # (잠깐 자리 비움 보호: 점심/화장실/외출 등)
            last_offline = last_record["checked_at"]
            elapsed_seconds = (now - last_offline).total_seconds()
            if elapsed_seconds >= grace_minutes * 60:
                check_out = last_offline  # grace 동안 재연결 없음 → 진짜 퇴근
            # else: None (잠깐 자리 비움, 근무중)
        elif last_record["status"] == "online":
            # 마지막이 online → 자리에 있음, 무조건 근무중
            # (poller가 상태 전환 시에만 INSERT하므로 침묵은 "online 유지" 의미)
            check_out = None

        return check_in, check_out

    def aggregate_today(self):
        """매 사이클 1회 실행. 활성 직원 각각에 대해 어제+오늘 두 work_date 처리."""
        cycle_start = time.time()

        # 정책 로드: grace_minutes (마지막 online 이후 N분 무재연결 = 퇴근 확정)
        grace_raw = self.db.get_policy("debounce_minutes")
        try:
            grace_minutes = int(grace_raw) if grace_raw else 60
        except ValueError:
            self.logger.warning(
                f"debounce_minutes 값 파싱 실패 ({grace_raw}), 기본 60 사용"
            )
            grace_minutes = 60

        # 정책 로드: cutoff_hour (새벽 N시 이전은 전일 work_date)
        cutoff_raw = self.db.get_policy("work_date_cutoff_hour")
        try:
            cutoff_hour = int(cutoff_raw) if cutoff_raw else 4
        except ValueError:
            self.logger.warning(
                f"work_date_cutoff_hour 값 파싱 실패 ({cutoff_raw}), 기본 4 사용"
            )
            cutoff_hour = 4

        # 시프트 매칭 정책 (정책 A 기반)
        grace_in_raw = self.db.get_policy("grace_in_minutes")
        try:
            grace_in_minutes = int(grace_in_raw) if grace_in_raw else 10
        except ValueError:
            self.logger.warning(
                f"grace_in_minutes 값 파싱 실패 ({grace_in_raw}), 기본 10 사용"
            )
            grace_in_minutes = 10

        grace_out_raw = self.db.get_policy("grace_out_minutes")
        try:
            grace_out_minutes = int(grace_out_raw) if grace_out_raw else 0
        except ValueError:
            self.logger.warning(
                f"grace_out_minutes 값 파싱 실패 ({grace_out_raw}), 기본 0 사용"
            )
            grace_out_minutes = 0

        # 시간형 출장/외근 판정 정책 (전부 기본 OFF — 현재 동작 유지)
        timed_trip_exempt_raw = self.db.get_policy("timed_trip_exempt")
        timed_trip_exempt = str(timed_trip_exempt_raw).strip().lower() == "true"

        lunch_deduct_raw = self.db.get_policy("lunch_deduct_enabled")
        lunch_deduct_enabled = str(lunch_deduct_raw).strip().lower() == "true"

        margin_raw = self.db.get_policy("timed_event_margin_hours")
        try:
            timed_event_margin_hours = float(margin_raw) if margin_raw else 0.0
        except (ValueError, TypeError):
            timed_event_margin_hours = 0.0

        # 점심 시각 (정책 2가 켜졌을 때만 사용; 기존 lunch_start/lunch_end 정책 재사용)
        lunch_start_str = self.db.get_policy("lunch_start") or "12:00"
        lunch_end_str = self.db.get_policy("lunch_end") or "13:00"

        today = self.db.get_work_date_kst(cutoff_hour)
        yesterday = today - timedelta(days=1)
        self.logger.info(
            f"=== Aggregate 사이클 시작 "
            f"(work_date today={today}, yesterday={yesterday}, "
            f"grace={grace_minutes}분, cutoff={cutoff_hour}시, "
            f"grace_in={grace_in_minutes}분, grace_out={grace_out_minutes}분) ==="
        )

        # 모든 직원 동일 기준 시각 사용 (UTC timezone-aware)
        now = datetime.now(timezone.utc)

        # 활성 직원 조회
        t0 = time.time()
        employees = self.db.get_active_employees()
        self.logger.info(
            f"  [1] 활성 직원 조회: {time.time()-t0:.3f}s ({len(employees)}건)"
        )

        if not employees:
            self.logger.debug("활성 직원 0건 — 사이클 건너뜀")
            return

        # Phase 6-2L+ B-3: work_date당 공휴일 조회 1회 캐싱 (직원 루프 밖에서)
        # 결근(absent) 판정 면제용. 출근기록 있으면 평소대로 처리.
        holiday_cache: dict = {
            yesterday: self.db.get_holiday(yesterday),
            today: self.db.get_holiday(today),
        }
        if holiday_cache[today]:
            self.logger.info(f"  공휴일 (오늘): {holiday_cache[today]}")
        if holiday_cache[yesterday]:
            self.logger.info(f"  공휴일 (어제): {holiday_cache[yesterday]}")

        # 직원별 처리 (어제 + 오늘 두 work_date)
        upsert_count = 0
        skip_no_data = 0
        skip_overridden = 0

        for emp in employees:
            for work_date in (yesterday, today):
                result = self._process_employee_work_date(
                    emp,
                    work_date,
                    grace_minutes,
                    cutoff_hour,
                    grace_in_minutes,
                    grace_out_minutes,
                    now,
                    holiday_name=holiday_cache.get(work_date),
                    timed_trip_exempt=timed_trip_exempt,
                    lunch_deduct_enabled=lunch_deduct_enabled,
                    timed_event_margin_hours=timed_event_margin_hours,
                    lunch_start_str=lunch_start_str,
                    lunch_end_str=lunch_end_str,
                )
                if result == "upsert":
                    upsert_count += 1
                elif result == "overridden":
                    skip_overridden += 1
                else:
                    skip_no_data += 1

            # 근무중 끊김 알림 — 오늘 work_date 에 대해서만 점검
            try:
                self._check_disconnect_alert(emp, today, cutoff_hour, now)
            except Exception as e:
                # 알림 로직 어떤 예외도 메인 루프 절대 중단시키지 않음
                self.logger.error(
                    f"_check_disconnect_alert 예외 (emp_id={emp.get('id')}): {e}"
                )

        # 직전 근무일 비정상 알림 — 직원 루프 밖에서 사이클당 1회 (대상은 DB가 추림)
        try:
            self._check_attendance_alerts(today, now)
        except Exception as e:
            self.logger.error(f"_check_attendance_alerts 예외: {e}")

        total = time.time() - cycle_start
        self.logger.info(
            f"=== 사이클 종료: {total:.3f}s "
            f"(upsert {upsert_count}, no_data {skip_no_data}, overridden {skip_overridden}) ==="
        )

    def _process_employee_work_date(
        self,
        emp: dict,
        work_date,
        grace_minutes: int,
        cutoff_hour: int,
        grace_in_minutes: int,
        grace_out_minutes: int,
        now: datetime,
        holiday_name: Optional[str] = None,
        timed_trip_exempt: bool = False,
        lunch_deduct_enabled: bool = False,
        timed_event_margin_hours: float = 0.0,
        lunch_start_str: str = "12:00",
        lunch_end_str: str = "13:00",
    ) -> str:
        """단일 직원 + 단일 work_date 처리. 반환: 'upsert' | 'overridden' | 'no_data'.

        Phase 6-2B: presence_raw가 없어도 캘린더에 휴가/외근 등록되어 있으면 처리.
        Phase 6-2L+ B-3: 공휴일이면 결근(absent) 면제 — 출근기록 없으면 daily 행을
                       만들지 않고(no_data), 출근기록 있으면 평소대로 처리.
        흐름:
          1) presence_raw → check_in/out 계산 (없으면 None, None)
          2) 캘린더 보정 확인 (get_auto_approved_request)
          3) 캘린더 있음 → category_id 적용, auto_status='normal',
             is_overridden=true, override_source='calendar'
          4) 캘린더 없음 + presence_raw도 없음 → no_data
             (공휴일이든 평일이든 동일)
          5) 캘린더 없음 + presence_raw 있음 → _determine_auto_status
             - 공휴일 + auto_status='absent' → no_data (daily 행 만들지 않음)
             - 그 외 → 평소대로 INSERT
        """
        emp_id = emp["id"]
        emp_no = emp.get("employee_no", "?")
        emp_name = emp.get("name", "?")

        # 1) presence_raw 기반 check_in/out (없으면 둘 다 None)
        raw = self.db.get_presence_raw_by_work_date(emp_id, work_date, cutoff_hour)
        if raw:
            check_in, check_out = self.compute_check_in_out(raw, grace_minutes, now)
        else:
            check_in, check_out = None, None

        # WiFi 단독 산출값 보존(아래 cal_in 융합이 check_in을 변형하므로 라이브 변수 말고 이 값 사용).
        wifi_check_in, wifi_check_out = check_in, check_out
        # "현재 사무실 재실 중" 판별: WiFi로 출근이 잡혔고(왔었고) WiFi 기준 아직 퇴근 안 함
        # (online 이거나, offline이어도 grace 이내) → 지금 재실 중으로 본다.
        # 재실 중이면 외근이 끝났어도 외근 종료시각을 퇴근으로 굳히지 않는다(복귀 후 조퇴 오판 방지).
        currently_present = (wifi_check_in is not None) and (wifi_check_out is None)

        # 2) 캘린더 자동 등록 보정 확인 (Phase 6-2B)
        active_requests = self.db.get_active_requests(emp_id, work_date)

        # 시프트 로깅에 쓰일 정보 (분기 둘 다에서 필요)
        shift_info = self.db.get_employee_shift(emp_id, work_date)

        if active_requests:
            # ── work_date의 실제 시간 범위 [day_start, day_end) 계산 (cutoff 기준) ──
            # corrected_check_in/out이 이 범위 안에 있는 시간형 일정만 융합/판정에 사용한다.
            # (날짜를 걸친 다른 날의 일정이 이 work_date로 새는 것 방지)
            from datetime import datetime as _dt, time as _time, timedelta as _td
            from zoneinfo import ZoneInfo
            _KST = ZoneInfo("Asia/Seoul")
            day_start = _dt.combine(work_date, _time(hour=cutoff_hour), tzinfo=_KST)
            day_end = day_start + _td(days=1)

            def _in_work_date(ts):
                """timestamptz ts가 이 work_date 범위 [day_start, day_end)에 속하는가."""
                if ts is None:
                    return False
                # ts를 KST로 변환해 비교 (tz-aware 보장)
                ts_kst = ts.astimezone(_KST) if ts.tzinfo is not None else ts.replace(tzinfo=_KST)
                return day_start <= ts_kst < day_end

            # 이 work_date 범위에 속하는 시간형 일정만 (융합·카테고리 공용)
            in_range_timed = [
                r for r in active_requests
                if r["corrected_check_in"] is not None
                and r["corrected_check_out"] is not None
                and _in_work_date(r["corrected_check_in"])
            ]

            # 시간형 일정(범위 내) vs 종일 일정 구분
            # 종일: corrected 둘 중 하나라도 None (날짜 범위로만 판단, 경계 필터 제외)
            has_allday = any(
                r["corrected_check_in"] is None or r["corrected_check_out"] is None
                for r in active_requests
            )

            # 정책1: 이미 시작된 부분만 합산 (미래 시작 제외) + work_date 범위 내 시간형만
            cal_in_candidates = []
            cal_out_candidates = []
            for r in in_range_timed:
                ci = r["corrected_check_in"]
                co = r["corrected_check_out"]
                if ci <= now:
                    cal_in_candidates.append(ci)
                if co <= now:
                    cal_out_candidates.append(co)

            # WiFi + 캘린더 융합 (가장 빠른 시작 ~ 가장 늦은 종료)
            if cal_in_candidates:
                check_in = (
                    min([check_in] + cal_in_candidates)
                    if check_in is not None
                    else min(cal_in_candidates)
                )
            # 재실 중(currently_present)이면 외근 종료를 퇴근으로 융합하지 않는다.
            # → check_out은 WiFi값(None) 그대로 유지되어 '근무중'으로 남는다(복귀 후 조퇴 오판 방지).
            # 복귀 안 하고 귀가(오프라인 유지·grace 경과)면 currently_present=False라 기존처럼 융합한다.
            if cal_out_candidates and not currently_present:
                check_out = (
                    max([check_out] + cal_out_candidates)
                    if check_out is not None
                    else max(cal_out_candidates)
                )

            # 정책1: 시작된 것도 없고 종일도 없고 WiFi도 없으면 → 아직 기록 없음
            if not has_allday and check_in is None and check_out is None:
                return "no_data"

            # 정책2: 대표 카테고리 — work_date 범위 내 시간형 + 종일 일정만 후보.
            #        (다른 날의 시간형이 카테고리로 새는 것도 방지)
            allday_reqs = [
                r for r in active_requests
                if r["corrected_check_in"] is None or r["corrected_check_out"] is None
            ]
            category_candidates = in_range_timed + allday_reqs
            if category_candidates:
                category_id = self._pick_category_for_now(category_candidates, now)
            else:
                # 범위 내 시간형도 종일도 없으면(이론상 드묾) 기존 전체에서 첫 요청
                category_id = self._pick_category_for_now(active_requests, now)
            is_overridden = True
            override_source = "calendar"

            # 종일 휴가/출장이면 결근/조퇴 판정 면제(정상). (기존 동작)
            # 정책1(timed_trip_exempt): 켜지면 시간형 출장/외근이 있는 날도 면제(normal).
            # 정책3(margin): 정책1이 꺼졌을 때만, 출장 시간 + 앞뒤 마진만큼 의무시간 차감.
            has_timed_trip = len(in_range_timed) > 0
            # 외근/출장이 "지금 진행 중"(시작 <= now < 종료)이면 아직 하루가 안 끝난 것.
            # 점심 끊김 등을 미리 퇴근/조퇴로 확정하지 않도록 판정을 보류한다.
            # 외근이 끝난 뒤 재연결이 없으면 다음 사이클에 위 융합으로 check_out=외근종료가
            # 되어 _determine_auto_status가 시프트종료와 비교해 정상/조퇴를 확정한다.
            has_ongoing_timed_trip = any(
                r["corrected_check_in"] is not None
                and r["corrected_check_out"] is not None
                and r["corrected_check_in"] <= now < r["corrected_check_out"]
                for r in in_range_timed
            )
            if has_allday:
                auto_status = "normal"
            elif timed_trip_exempt and has_timed_trip:
                # 정책1 ON + 시간형 출장/외근 존재 → 판정 면제
                auto_status = "normal"
            elif has_ongoing_timed_trip:
                # 외근/출장 진행 중 → 퇴근/조퇴 확정 보류, '근무중(외근중)'으로 둔다.
                # check_out도 비워 점심 끊김 시각이 퇴근으로 굳지 않게 한다.
                check_out = None
                auto_status = "working"
            elif check_in is not None and check_out is not None:
                # 정책3용: 이 work_date 범위 내 시간형 일정 총 시간(분) 합산
                trip_minutes = 0
                for r in in_range_timed:
                    ci = r["corrected_check_in"]
                    co = r["corrected_check_out"]
                    if ci is not None and co is not None and co > ci:
                        trip_minutes += int((co - ci).total_seconds() // 60)
                auto_status = self._determine_auto_status(
                    check_in=check_in,
                    check_out=check_out,
                    shift_info=shift_info,
                    grace_in_minutes=grace_in_minutes,
                    grace_out_minutes=grace_out_minutes,
                    lunch_deduct_enabled=lunch_deduct_enabled,
                    lunch_start_str=lunch_start_str,
                    lunch_end_str=lunch_end_str,
                    trip_minutes=trip_minutes,
                    margin_hours=timed_event_margin_hours,
                )
            elif check_in is not None:
                auto_status = "working"
            else:
                auto_status = "normal"
        else:
            # 4) 캘린더 없음 + presence_raw 없음 → INSERT 의미 없음
            if not raw or (check_in is None and check_out is None):
                return "no_data"

            # 5) 캘린더 없음 + presence_raw 있음 → 기존 로직
            category_id = None
            is_overridden = False
            override_source = None
            auto_status = self._determine_auto_status(
                check_in=check_in,
                check_out=check_out,
                shift_info=shift_info,
                grace_in_minutes=grace_in_minutes,
                grace_out_minutes=grace_out_minutes,
                lunch_deduct_enabled=lunch_deduct_enabled,
                lunch_start_str=lunch_start_str,
                lunch_end_str=lunch_end_str,
            )

            # Phase 6-2L+ B-3: 공휴일이면 결근(absent) 면제 → daily 행 만들지 않음.
            # 출근기록이 있어 normal/working/late/early_leave가 나오면 평소대로 INSERT.
            if holiday_name and auto_status == "absent":
                self.logger.debug(
                    f"  직원 {emp_id}({emp_no}/{emp_name}) work_date={work_date} "
                    f"— 공휴일({holiday_name}) absent 면제, 행 생성 안 함"
                )
                return "no_data"

        # work_minutes 계산 (분기 무관)
        work_minutes = None
        if check_in is not None and check_out is not None:
            delta = check_out - check_in
            work_minutes = int(delta.total_seconds() // 60)

        new_id = self.db.upsert_attendance_daily(
            employee_id=emp_id,
            work_date=work_date,
            check_in=check_in,
            check_out=check_out,
            work_minutes=work_minutes,
            auto_status=auto_status,
            category_id=category_id,
            is_overridden=is_overridden,
            override_source=override_source,
        )

        if new_id is None:
            self.logger.debug(
                f"  직원 {emp_id}({emp_no}/{emp_name}) work_date={work_date} "
                f"— is_overridden=true 로 보호됨, 스킵"
            )
            return "overridden"
        else:
            shift_label = (
                f"shift={shift_info['patternName']}({shift_info['start']}~{shift_info['end']})"
                if shift_info and shift_info.get("start") and shift_info.get("end")
                else "shift=none"
            )
            calendar_label = (
                f", 보정(category_id={category_id}, 요청 {len(active_requests)}건)"
                if active_requests else ""
            )
            self.logger.info(
                f"  직원 {emp_id}({emp_no}/{emp_name}) work_date={work_date} — "
                f"check_in={check_in}, check_out={check_out}, "
                f"work_minutes={work_minutes}, auto_status={auto_status}, "
                f"{shift_label}, id={new_id}{calendar_label}"
            )
            return "upsert"

    def _pick_category_for_now(self, requests, now):
        """현재 시각 기준 대표 카테고리.
        1)지금 진행 중 시간형 → 2)이미 끝난 시간형 중 가장 늦게 끝난 것
        → 3)종일 일정 → 4)첫 요청.
        """
        for r in requests:
            ci, co = r["corrected_check_in"], r["corrected_check_out"]
            if ci is not None and co is not None and ci <= now < co:
                return r["category_id"]
        ended = [
            r for r in requests
            if r["corrected_check_in"] is not None
            and r["corrected_check_out"] is not None
            and r["corrected_check_out"] <= now
        ]
        if ended:
            ended.sort(key=lambda r: r["corrected_check_out"])
            return ended[-1]["category_id"]
        allday = [
            r for r in requests
            if r["corrected_check_in"] is None or r["corrected_check_out"] is None
        ]
        if allday:
            return allday[0]["category_id"]
        return requests[0]["category_id"]

    def _determine_auto_status(
        self,
        check_in: Optional[datetime],
        check_out: Optional[datetime],
        shift_info: Optional[dict],
        grace_in_minutes: int,
        grace_out_minutes: int,
        lunch_deduct_enabled: bool = False,
        lunch_start_str: str = "12:00",
        lunch_end_str: str = "13:00",
        trip_minutes: int = 0,
        margin_hours: float = 0.0,
    ) -> Optional[str]:
        """
        정책 A 기반 auto_status 판정.

        규칙:
        1) 시프트 정보 없거나 휴무:
           - check_in + check_out 둘 다 → normal
           - check_in만 → working (근무 중)
           - 둘 다 NULL → absent
        2) 시프트 있음 + 둘 다 NULL → absent
        3) 시프트 있음 + check_out만 → None (판정 보류, 이론상 거의 없음)
        4) 시프트 있음 + check_in 있음 (check_out 유무 무관):
           - 출근 시각 > 시프트 시작 + grace_in_minutes → late (퇴근 전에도 확정)
           - check_out 없음 + 지각 아님 → working (근무 중)
           - check_out 있음 + 근무시간 < 시프트 총 - grace_out_minutes → early_leave
           - 그 외 → normal
        """
        from datetime import timedelta

        # 시프트 없거나 휴무 → 단순 판정
        if (
            shift_info is None
            or shift_info.get("type") == "off"
            or not shift_info.get("start")
            or not shift_info.get("end")
        ):
            if check_in is not None and check_out is not None:
                return "normal"
            elif check_in is not None and check_out is None:
                return "working"  # 시프트 없을 때도 출근만 있으면 근무 중
            elif check_in is None and check_out is None:
                return "absent"
            else:
                return None

        # 시프트 있음 + 둘 다 NULL → absent
        if check_in is None and check_out is None:
            return "absent"

        # 시프트 있음 + check_out만 (이론상 거의 없음) → None (판정 보류)
        if check_in is None and check_out is not None:
            return None

        # 여기 도달 = check_in은 반드시 있음 (check_out은 있을 수도/없을 수도)

        # 시프트 시작/종료 시각 파싱 ("HH:MM")
        shift_start_str = shift_info["start"]
        shift_end_str = shift_info["end"]
        try:
            sh_h, sh_m = map(int, shift_start_str.split(":"))
            eh_h, eh_m = map(int, shift_end_str.split(":"))
        except (ValueError, AttributeError):
            # 시프트 시각 파싱 실패 → 출근만이면 근무 중, 둘 다면 정상
            return "working" if check_out is None else "normal"

        # 시프트 총 근무시간 (분), 자정 넘김 처리 (예: 22:00~06:00)
        shift_minutes = (eh_h * 60 + eh_m) - (sh_h * 60 + sh_m)
        if shift_minutes <= 0:
            shift_minutes += 24 * 60

        # 시프트 시작 시각을 check_in 날짜 기준 datetime으로 변환
        shift_start_dt = check_in.replace(
            hour=sh_h, minute=sh_m, second=0, microsecond=0
        )
        late_threshold = shift_start_dt + timedelta(minutes=grace_in_minutes)

        # 1) 출근 지각 체크 — 출근 시각만으로 확정 (퇴근 전에도 지각 판정)
        is_late = check_in > late_threshold

        # 2) 아직 퇴근 전(check_out 없음): 지각이면 late, 아니면 working(근무 중)
        if check_out is None:
            return "late" if is_late else "working"

        # 3) 퇴근까지 있음: 지각 우선 → 조퇴 → 정상
        if is_late:
            return "late"

        actual_minutes = int((check_out - check_in).total_seconds() / 60)

        # 정책2: 점심 차감 — check_in~check_out과 점심시간이 겹치는 만큼 근무시간에서 제외.
        #        (켜졌을 때만; 시프트도 점심 포함이라 양쪽 일관성 위해 required에서도 동일 차감)
        lunch_overlap = 0
        if lunch_deduct_enabled:
            try:
                ls_h, ls_m = map(int, str(lunch_start_str).split(":"))
                le_h, le_m = map(int, str(lunch_end_str).split(":"))
                lunch_start_dt = check_in.replace(hour=ls_h, minute=ls_m, second=0, microsecond=0)
                lunch_end_dt = check_in.replace(hour=le_h, minute=le_m, second=0, microsecond=0)
                # 실제 근무 구간(check_in~check_out)과 점심 구간의 교집합(분)
                ov_start = max(check_in, lunch_start_dt)
                ov_end = min(check_out, lunch_end_dt)
                if ov_end > ov_start:
                    lunch_overlap = int((ov_end - ov_start).total_seconds() // 60)
            except (ValueError, AttributeError):
                lunch_overlap = 0
        actual_minutes -= lunch_overlap

        # required: 시프트 총시간 - grace_out
        required_minutes = shift_minutes - grace_out_minutes

        # 정책2: 점심 차감 시 시프트(의무)에서도 점심만큼 차감 (양쪽 동일 기준)
        if lunch_deduct_enabled:
            # 시프트 전체에 점심이 포함된다고 보고 점심 길이만큼 의무 축소
            try:
                ls_h, ls_m = map(int, str(lunch_start_str).split(":"))
                le_h, le_m = map(int, str(lunch_end_str).split(":"))
                lunch_len = (le_h * 60 + le_m) - (ls_h * 60 + ls_m)
                if lunch_len > 0:
                    required_minutes -= lunch_len
            except (ValueError, AttributeError):
                pass

        # 정책3: 앞뒤 마진(margin_hours)이 설정됐을 때만, 출장 시간 + 앞뒤 마진만큼
        #        의무시간 차감. margin_hours=0(기본 OFF)이면 출장이 있어도 차감하지 않아
        #        기존 판정과 100% 동일하게 동작한다.
        if margin_hours > 0:
            margin_minutes = int(margin_hours * 60)
            required_minutes -= (trip_minutes + 2 * margin_minutes)

        # 음수 방지
        if required_minutes < 0:
            required_minutes = 0

        if actual_minutes < required_minutes:
            return "early_leave"
        return "normal"

    def _check_attendance_alerts(self, today, now: datetime) -> None:
        """직전 근무일이 비정상인 직원에게 '근태 확인 요청' 메일 발송.

        - 직원 루프 밖에서 사이클당 1회 호출.
        - 발송 대상은 get_pending_attendance_alerts()가 DB에서 추려준다(보통 0명).
        - 각 대상에 대해 '오늘 시프트 출근시각'을 지났을 때만 발송.
          · 시프트 없음/휴무(off)/시작시각 없음 → 발송 안 함(스킵).
          · 아직 출근시각 전 → 스킵(다음 사이클에 재시도).
        - 중복 방지: try_log_attendance_alert로 '로그 먼저' 성공 시에만 발송.
        - 메일 형식은 기존 끊김 알림과 동일 톤. 날짜는 실제 직전 근무일을 표기.
        """
        try:
            pending = self.db.get_pending_attendance_alerts()
        except Exception as e:
            self.logger.error(f"  [attn-alert] 대상 조회 실패: {e}")
            return

        if not pending:
            return

        now_kst = now.astimezone(KST)
        status_kr = {"absent": "결근", "late": "지각", "early_leave": "조퇴"}
        weekday_kr = ["월", "화", "수", "목", "금", "토", "일"]

        for p in pending:
            emp_id = p["id"]
            email = p.get("email")
            if not email:
                continue

            # 오늘 시프트 출근시각 확인 (시프트 없거나 휴무면 발송 안 함 — 결정사항 A)
            try:
                shift = self.db.get_employee_shift(emp_id, today)
            except Exception as e:
                self.logger.error(f"  [attn-alert] 시프트 조회 실패 (emp={emp_id}): {e}")
                continue
            if not shift or shift.get("type") == "off" or not shift.get("start"):
                continue
            try:
                sh_h, sh_m = map(int, str(shift["start"]).split(":"))
            except (ValueError, AttributeError):
                continue
            shift_start_dt = now_kst.replace(
                hour=sh_h, minute=sh_m, second=0, microsecond=0
            )
            if now_kst < shift_start_dt:
                # 아직 출근시각 전 → 다음 사이클에 재시도
                continue

            status = p["auto_status"]
            work_date = p["work_date"]

            # 로그 먼저 → 성공(새 기록) 시에만 발송 (중복 차단)
            try:
                ok_to_send = self.db.try_log_attendance_alert(emp_id, work_date, status)
            except Exception as e:
                self.logger.error(f"  [attn-alert] 로그 기록 실패 (emp={emp_id}): {e}")
                continue
            if not ok_to_send:
                # 이미 보냄
                continue

            # 메일 작성/발송
            name = p.get("name", "")
            status_label = status_kr.get(status, status)
            try:
                dow = weekday_kr[work_date.weekday()]
                wd_str = f"{work_date.strftime('%Y-%m-%d')}({dow})"
            except Exception:
                wd_str = str(work_date)
            subject = "[VanaM 근태관리] 근태 확인 요청"
            body = (
                f"{name} 님,\n\n"
                f"{wd_str} 근태가 '{status_label}'(으)로 기록되었습니다.\n"
                f"확인이 필요하시면 근태 시스템에서 정정을 신청해주세요.\n\n"
                f"[해당 메일은 자동 전송 되었습니다.]"
            )
            ok = self.notifier.send(email, subject, body)
            if ok:
                self.logger.info(
                    f"  [attn-alert] 발송 (emp={emp_id}, name={name}, "
                    f"email={email}, work_date={work_date}, status={status})"
                )
            else:
                # 발송 실패 시 로그는 이미 들어갔으므로 재발송되지 않는다(누락<중복 우선 결정).
                self.logger.warning(
                    f"  [attn-alert] 발송 실패하였으나 로그는 기록됨 "
                    f"(emp={emp_id}, work_date={work_date})"
                )

    def _check_disconnect_alert(
        self,
        emp: dict,
        today,
        cutoff_hour: int,
        now: datetime,
    ) -> None:
        """근무중 끊김 알림 점검 — 오늘 work_date 기준.

        조건이 모두 맞으면 메일 1통 발송하고 self._disconnect_notified에 기록.
        - 알림 안 함 조건(아래 중 하나라도 해당):
          · 직원 이메일 없음
          · 오늘 시프트가 휴무/미배정
          · 현재 시각이 시프트 [start, end] 밖
          · 현재 시각이 점심시간 [lunch_start, lunch_end] 안
          · 오늘 presence_raw 마지막이 'online' (연결됨)
        - 끊김 판정:
          A) raw 마지막 'offline' + (now - 마지막.checked_at) >= 임계분
          B) raw 비어있음 + (시프트 start + 임계분) <= now
        - 임계분: hr.policy_settings.disconnect_alert_minutes (기본 30)
        - 점심: lunch_start/lunch_end (기본 12:00/13:00)
        """
        email = emp.get("email")
        if not email:
            return

        emp_id = emp["id"]

        # 0) 오늘 승인된 부재(휴가/외근/출장/재택)가 있으면 알림 자체를 스킵.
        #    회사 WiFi에 안 잡히는 게 정상인 날이므로 상태도 리셋.
        try:
            absence = self.db.get_active_absence_today(emp_id, today)
        except Exception as e:
            self.logger.debug(
                f"  [disconnect] get_active_absence_today 실패 (emp={emp_id}): {e}"
            )
            absence = None
        if absence:
            self.logger.debug(
                f"[끊김알림] {emp.get('name')} 오늘 부재({absence}) — 스킵"
            )
            self._disconnect_notified.pop(emp_id, None)
            return

        # 1) 오늘 시프트 조회
        try:
            shift = self.db.get_employee_shift(emp_id, today)
        except Exception as e:
            self.logger.debug(
                f"  [disconnect] get_employee_shift 실패 (emp={emp_id}): {e}"
            )
            return
        if (
            not shift
            or shift.get("type") == "off"
            or not shift.get("start")
            or not shift.get("end")
        ):
            # 휴무/미배정 → 상태 리셋
            self._disconnect_notified.pop(emp_id, None)
            return

        # 2) 현재 KST 시각 — now가 timezone-aware(UTC)면 KST로 변환
        if now.tzinfo is not None:
            now_kst = now.astimezone(KST)
        else:
            # 비정상 케이스: tz 없으면 system tz 가정 (컨테이너 TZ=Asia/Seoul)
            now_kst = now

        # 3) 시프트 시각 [start, end] 밖이면 알림 안 함 (KST today 기준)
        try:
            sh_h, sh_m = map(int, str(shift["start"]).split(":"))
            eh_h, eh_m = map(int, str(shift["end"]).split(":"))
        except (ValueError, AttributeError):
            return

        # 야간 시프트(end <= start, 예: 22:00~06:00)는 끊김 알림 대상 X — 복잡해서 skip
        if (eh_h * 60 + eh_m) <= (sh_h * 60 + sh_m):
            self._disconnect_notified.pop(emp_id, None)
            return

        shift_start_dt = now_kst.replace(
            hour=sh_h, minute=sh_m, second=0, microsecond=0
        )
        shift_end_dt = now_kst.replace(
            hour=eh_h, minute=eh_m, second=0, microsecond=0
        )
        if now_kst < shift_start_dt or now_kst > shift_end_dt:
            # 근무시간 밖 → 상태 리셋 (다음 근무시간에 깨끗하게 시작)
            self._disconnect_notified.pop(emp_id, None)
            return

        # 4) 점심시간 안이면 알림 안 함
        lunch_start_raw = self.db.get_policy("lunch_start") or "12:00"
        lunch_end_raw = self.db.get_policy("lunch_end") or "13:00"
        try:
            ls_h, ls_m = map(int, str(lunch_start_raw).split(":"))
            le_h, le_m = map(int, str(lunch_end_raw).split(":"))
            lunch_start_dt = now_kst.replace(
                hour=ls_h, minute=ls_m, second=0, microsecond=0
            )
            lunch_end_dt = now_kst.replace(
                hour=le_h, minute=le_m, second=0, microsecond=0
            )
            if lunch_start_dt <= now_kst <= lunch_end_dt:
                return
        except (ValueError, AttributeError):
            pass  # 점심 정책 파싱 실패는 무시 (점심 체크만 skip)

        # 5) 임계분 정책 (기본 30)
        try:
            threshold_min = int(self.db.get_policy("disconnect_alert_minutes") or 30)
        except (TypeError, ValueError):
            threshold_min = 30

        # 6) 오늘 presence_raw 조회 (오름차순)
        try:
            raw = self.db.get_presence_raw_by_work_date(emp_id, today, cutoff_hour)
        except Exception as e:
            self.logger.debug(
                f"  [disconnect] get_presence_raw_by_work_date 실패 (emp={emp_id}): {e}"
            )
            return

        # 7) 끊김 판정
        disconnected = False
        last_seen: Optional[datetime] = None  # 마지막으로 online이었던 시각

        if not raw:
            # B) 오늘 한 번도 안 잡힘 — 시프트 시작 + 임계분이 지났는지 확인
            #     비교는 같은 timezone 기준(now_kst aware vs shift_start_dt aware → OK)
            if shift_start_dt + timedelta(minutes=threshold_min) <= now_kst:
                disconnected = True
                last_seen = None
        else:
            last_record = raw[-1]
            if last_record["status"] == "online":
                # 연결됨 → 상태 리셋 후 return (재연결 후 또 끊기면 다시 발송)
                self._disconnect_notified.pop(emp_id, None)
                return
            elif last_record["status"] == "offline":
                # A) 마지막 offline 이후 임계분 경과 여부
                last_offline_at = last_record["checked_at"]
                # presence_raw.checked_at은 timezone-aware (DB timestamptz)
                # now도 aware(UTC) → 차이 계산 가능
                elapsed = (now - last_offline_at).total_seconds()
                if elapsed >= threshold_min * 60:
                    disconnected = True
                    # 가장 최근 'online' 기록을 last_seen으로
                    for r in reversed(raw):
                        if r["status"] == "online":
                            last_seen = r["checked_at"]
                            break

        if not disconnected:
            return

        # 8) 오늘 이미 보낸 적 있으면 스킵
        today_str = today.isoformat()
        if self._disconnect_notified.get(emp_id) == today_str:
            return

        # 9) 메일 발송
        emp_name = emp.get("name", "")
        subject = "[VanaM 근태관리] WIFI 연결 끊김 알림"
        body_lines = [
            f"{emp_name} 님,",
            "",
            f"사내 WiFi 연결이 {threshold_min}분 이상 확인되지 않았습니다.",
            "현재 연결 상태를 확인해주세요.",
            "",
            "[해당 메일은 자동 전송 되었습니다.]",
        ]
        if last_seen is not None:
            try:
                last_seen_kst = (
                    last_seen.astimezone(KST) if last_seen.tzinfo is not None else last_seen
                )
                body_lines.insert(
                    2,
                    f"마지막 연결 시각: {last_seen_kst.strftime('%Y-%m-%d %H:%M:%S')} (KST)",
                )
            except Exception:
                pass
        body = "\n".join(body_lines)

        ok = self.notifier.send(email, subject, body)
        if ok:
            self._disconnect_notified[emp_id] = today_str
            self.logger.info(
                f"  [disconnect] 알림 발송 (emp={emp_id}, name={emp_name}, "
                f"email={email}, threshold={threshold_min}분)"
            )

    def run(self):
        """메인 루프. time.monotonic() 기반 fixed-rate scheduling.

        run_once() 소요 시간이 sleep에 누적되지 않도록 다음 wake-up 시각을 절대값으로 계산.
        근태 분 단위 정확성 위해 정확히 interval을 유지.
        """
        self.logger.info("Aggregator 시작")
        self.logger.info(
            f"INTERVAL_SECONDS={self.config.interval_seconds}, "
            f"LOG_LEVEL={self.config.log_level}"
        )

        next_run_at = time.monotonic()
        interval = self.config.interval_seconds

        while self.running:
            try:
                now = time.monotonic()

                if now >= next_run_at:
                    next_run_at += interval
                    self.aggregate_today()

                    behind = time.monotonic() - next_run_at
                    if behind > 0:
                        skip_count = int(behind // interval) + 1
                        self.logger.warning(
                            f"사이클이 {behind:.1f}초 지연됨 — {skip_count}회 skip"
                        )
                        next_run_at += skip_count * interval
                else:
                    sleep_time = min(1.0, next_run_at - now)
                    time.sleep(sleep_time)

            except Exception as e:
                self.logger.exception(f"Aggregate 루프 예외: {e}")
                time.sleep(60)
                next_run_at = time.monotonic()

        self.logger.info("Aggregator 정상 종료")

    def stop(self, sig=None, frame=None):
        self.logger.info(f"종료 시그널 수신 ({sig}) — 다음 루프에서 종료")
        self.running = False


def main():
    aggregator = Aggregator()
    signal.signal(signal.SIGINT, aggregator.stop)
    if hasattr(signal, "SIGTERM"):
        try:
            signal.signal(signal.SIGTERM, aggregator.stop)
        except (ValueError, OSError):
            pass
    try:
        aggregator.run()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
