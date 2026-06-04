"""Google Calendar 읽기 전용 클라이언트 (1단계).

서비스 계정 + 도메인 위임(with_subject)으로 인증해 근태 캘린더의 일정을 읽는다.
events().list 만 호출 — 생성/수정/삭제는 절대 하지 않는다.
"""

from datetime import datetime, timedelta

from google.oauth2 import service_account
from googleapiclient.discovery import build

# 도메인 위임 admin 콘솔에 등록된 scope(calendar)와 일치시킴.
# 1단계는 코드에 쓰기 메서드를 두지 않아 실제로는 읽기만 한다.
# readonly로 좁히려면 admin 콘솔에 calendar.readonly도 추가 등록 필요.
SCOPES = ["https://www.googleapis.com/auth/calendar"]


class CalendarClient:
    def __init__(self, key_file: str, subject_email: str):
        """서비스 계정 키 로드 + 도메인 위임 + Calendar v3 서비스 빌드.

        인증 실패 시 명확한 예외 메시지로 다시 던진다.
        """
        try:
            credentials = service_account.Credentials.from_service_account_file(
                key_file, scopes=SCOPES
            )
            # 도메인 위임 — 대행할 사용자 계정
            delegated = credentials.with_subject(subject_email)
            self.service = build("calendar", "v3", credentials=delegated, cache_discovery=False)
            self.subject_email = subject_email
        except FileNotFoundError as e:
            raise RuntimeError(
                f"서비스 계정 키 파일을 찾을 수 없습니다: {key_file}"
            ) from e
        except Exception as e:
            raise RuntimeError(
                f"Google Calendar 인증 실패 (key_file={key_file}, subject={subject_email}): {e}"
            ) from e

    def list_events(
        self,
        calendar_id: str,
        time_min: datetime,
        time_max: datetime,
        max_results: int = 250,
    ) -> list[dict]:
        """해당 캘린더의 일정 조회 (singleEvents=True, startTime 정렬).

        time_min/time_max는 timezone-aware datetime이어야 함 (isoformat으로 변환).
        페이지네이션은 1단계에선 생략하고 max_results 250으로 충분.
        """
        resp = (
            self.service.events()
            .list(
                calendarId=calendar_id,
                timeMin=time_min.isoformat(),
                timeMax=time_max.isoformat(),
                singleEvents=True,
                orderBy="startTime",
                maxResults=max_results,
            )
            .execute()
        )
        return resp.get("items", [])

    def parse_event(self, event: dict) -> dict:
        """일정 1건에서 필요한 필드 추출.

        반환: {
            event_id, summary, start_raw, is_all_day,
            start_date_or_datetime, creator_email, ext_props,
            attendees,
        }
        - start에 "date"가 있으면 종일(all_day), "dateTime"이면 시간지정
        - creator는 event.creator.email
        - ext_props는 event.extendedProperties.private (시스템 생성분 판별용)
        - attendees는 [{"email": str, "response_status": str}] — accepted/declined/
          tentative/needsAction. 호출자는 'accepted'만 근태 처리하는 식으로 필터.
        """
        start = event.get("start", {}) or {}
        is_all_day = "date" in start
        start_date_or_datetime = start.get("date") or start.get("dateTime")

        creator_email = (event.get("creator", {}) or {}).get("email")
        ext_props = (event.get("extendedProperties", {}) or {}).get("private", {}) or {}

        # 참석자 (email + responseStatus). email 없는 항목은 제외 (캘린더 자원 등).
        attendees = [
            {
                "email": a.get("email"),
                "response_status": a.get("responseStatus"),
            }
            for a in (event.get("attendees") or [])
            if a.get("email")
        ]

        return {
            "event_id": event.get("id"),
            "summary": event.get("summary", "(제목 없음)"),
            "start_raw": start,
            "is_all_day": is_all_day,
            "start_date_or_datetime": start_date_or_datetime,
            "creator_email": creator_email,
            "ext_props": ext_props,
            "attendees": attendees,
        }

    def insert_event(
        self,
        calendar_id: str,
        title: str,
        start_date: str,
        end_date: str,
        source: str = "inventory",
    ) -> str:
        """종일 일정을 캘린더에 등록. 등록된 event id 반환.

        Args:
            calendar_id: Google Calendar ID
            title: 일정 제목 (호출자가 완성된 문자열로 전달, 가공하지 않음)
            start_date: 시작 날짜 "YYYY-MM-DD"
            end_date: 종료 날짜 "YYYY-MM-DD" (start와 같으면 하루짜리)
            source: extendedProperties.private.vanam_source 값 (기본 "inventory").
                    syncer가 이 표시를 보고 자기가 만든 일정은 스킵 (무한루프 방지).

        Note:
            Google Calendar API의 종일 일정은 end.date가 exclusive(종료일 다음날).
            화면상 종료일이 맞게 보이도록 받은 end_date에 +1일 적용.
        """
        # YYYY-MM-DD 파싱 + 1일 더하기 (Google API exclusive end 처리)
        end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
        end_exclusive = (end_dt + timedelta(days=1)).strftime("%Y-%m-%d")

        body = {
            "summary": title,
            "description": "재고관리 시스템에서 자동 생성된 일정입니다.",
            "start": {"date": start_date},
            "end": {"date": end_exclusive},
            "extendedProperties": {
                "private": {
                    "vanam_source": source,
                }
            },
        }

        created = (
            self.service.events()
            .insert(calendarId=calendar_id, body=body)
            .execute()
        )
        return created.get("id", "")
