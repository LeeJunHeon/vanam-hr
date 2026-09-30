"""Google Calendar 클라이언트.

서비스 계정 + 도메인 위임(with_subject)으로 인증한다.
- 메인 루프(일정 동기화): events().list
- Flask HTTP 스레드(내부 API): events().insert / patch / delete

스레드 안전: 두 스레드가 같은 self.service 를 쓴다. httplib2.Http 는 스레드 안전하지 않으므로
(google-api-python-client docs/thread_safety) requestBuilder 로 요청마다 새 AuthorizedHttp(새 httplib2.Http)
를 만든다. 호출부(self.service.events()...execute())는 그대로 써도 요청끼리 연결을 공유하지 않는다.
"""

from datetime import datetime, timedelta

import google_auth_httplib2
import httplib2
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import HttpRequest

# 기존 build(credentials=...) 가 쓰던 googleapiclient.http.build_http 기본 타임아웃과 같다.
HTTP_TIMEOUT_SECONDS = 60

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
            self.service = self._build_service(delegated)
            self.subject_email = subject_email
        except FileNotFoundError as e:
            raise RuntimeError(
                f"서비스 계정 키 파일을 찾을 수 없습니다: {key_file}"
            ) from e
        except Exception as e:
            raise RuntimeError(
                f"Google Calendar 인증 실패 (key_file={key_file}, subject={subject_email}): {e}"
            ) from e

    @staticmethod
    def _new_http(credentials) -> google_auth_httplib2.AuthorizedHttp:
        """요청 1건용 인증 연결 — 매번 새 httplib2.Http (스레드 간 공유 안 함)."""
        return google_auth_httplib2.AuthorizedHttp(
            credentials, http=httplib2.Http(timeout=HTTP_TIMEOUT_SECONDS)
        )

    @classmethod
    def _build_service(cls, credentials):
        """Calendar v3 서비스. requestBuilder 가 요청마다 새 연결로 HttpRequest 를 만든다.

        build() 에는 credentials 와 http 를 함께 넘길 수 없어 http 에도 AuthorizedHttp 를 넘긴다
        (정적 discovery 라 이 연결로 discovery 를 받지는 않는다).
        """

        def request_builder(_http, *args, **kwargs):
            return HttpRequest(cls._new_http(credentials), *args, **kwargs)

        return build(
            "calendar",
            "v3",
            http=cls._new_http(credentials),
            requestBuilder=request_builder,
            cache_discovery=False,
        )

    def list_events(
        self,
        calendar_id: str,
        time_min: datetime,
        time_max: datetime,
        max_results: int = 250,
    ) -> list[dict]:
        """해당 캘린더의 일정 조회 (singleEvents=True, startTime 정렬).

        time_min/time_max는 timezone-aware datetime이어야 함 (isoformat으로 변환).
        nextPageToken 을 따라 모든 페이지를 합쳐 반환한다(페이지당 max_results).
        페이지 도중 예외는 그대로 올린다 — 호출자가 이 캘린더를 "조회 실패"로 본다.
        """
        items: list[dict] = []
        page_token = None
        while True:
            params = dict(
                calendarId=calendar_id,
                timeMin=time_min.isoformat(),
                timeMax=time_max.isoformat(),
                singleEvents=True,
                orderBy="startTime",
                maxResults=max_results,
            )
            if page_token:
                params["pageToken"] = page_token
            resp = self.service.events().list(**params).execute()
            items.extend(resp.get("items", []))
            page_token = resp.get("nextPageToken")
            if not page_token:
                return items

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
