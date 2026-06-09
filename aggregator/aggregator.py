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

        # 2) 캘린더 자동 등록 보정 확인 (Phase 6-2B)
        calendar_request = self.db.get_auto_approved_request(emp_id, work_date)

        # 시프트 로깅에 쓰일 정보 (분기 둘 다에서 필요)
        shift_info = self.db.get_employee_shift(emp_id, work_date)

        if calendar_request:
            # 3) 캘린더에 휴가/외근 등록 → 자동 적용
            category_id = calendar_request["category_id"]

            # Phase 6-2L: 캘린더 시간 + WiFi 시간 합치기 (min/max)
            # - WiFi만 있으면 그대로 (cal_* 모두 None)
            # - 캘린더 시간만 있으면 그대로 사용
            # - 둘 다 있으면 가장 빠른 출근 + 가장 늦은 퇴근
            # - 종일 일정(cal_* 모두 None)이면 presence_raw 기반 그대로 유지
            #   → 휴가인데 사무실 잠깐 들렀어도 출근 기록 보존
            cal_in = calendar_request["corrected_check_in"]
            cal_out = calendar_request["corrected_check_out"]

            if cal_in is not None:
                if check_in is None:
                    check_in = cal_in
                else:
                    # 가장 빠른 출근 (WiFi 새벽 출근 + 캘린더 13:00 외근 → WiFi)
                    check_in = min(check_in, cal_in)

            if cal_out is not None:
                if check_out is None:
                    check_out = cal_out
                else:
                    # 가장 늦은 퇴근 (WiFi 18:00 + 캘린더 15:00 외근 종료 → WiFi)
                    check_out = max(check_out, cal_out)

            auto_status = "normal"  # 캘린더 자동 등록은 항상 정상 (휴가/외근은 결근 아님)
            is_overridden = True    # 다음 사이클 보호
            # Phase 6-2L+ C-1: 캘린더 보정 출처 마킹 → upsert WHERE 절에서 재갱신 허용
            override_source = "calendar"
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
                f", 캘린더보정(category_id={category_id}, reason='{calendar_request['reason']}')"
                if calendar_request else ""
            )
            self.logger.info(
                f"  직원 {emp_id}({emp_no}/{emp_name}) work_date={work_date} — "
                f"check_in={check_in}, check_out={check_out}, "
                f"work_minutes={work_minutes}, auto_status={auto_status}, "
                f"{shift_label}, id={new_id}{calendar_label}"
            )
            return "upsert"

    def _determine_auto_status(
        self,
        check_in: Optional[datetime],
        check_out: Optional[datetime],
        shift_info: Optional[dict],
        grace_in_minutes: int,
        grace_out_minutes: int,
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
        required_minutes = shift_minutes - grace_out_minutes
        if actual_minutes < required_minutes:
            return "early_leave"
        return "normal"

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
            f"사내 WiFi 연결이 {threshold_min}분 이상 확인되지 않았습니다.",
            "현재 연결 상태를 확인해주세요.",
            "[해당 메일은 자동 전송 되었습니다.]",
        ]
        if last_seen is not None:
            try:
                last_seen_kst = (
                    last_seen.astimezone(KST) if last_seen.tzinfo is not None else last_seen
                )
                body_lines.insert(
                    1,
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
