"""환경변수 로드 + Config dataclass 정의 (calendar-syncer)."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# 프로젝트 루트의 .env 로드 (calendar-syncer/ 는 서브폴더이므로 부모 경로)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))


# 근태 관련 캘린더 (1단계 임시 하드코딩, 2단계에서 DB calendar_sources 테이블로 이전 예정)
CALENDARS = {
    "vacation": {
        "name": "VanaM_Vacation",
        "id": "c_4b0efc90be2ec28f01bbf7387724b6fb17d0014c17a4370b1fbbc30b753b908a@group.calendar.google.com",
    },
    "field_trip": {
        "name": "VanaM_Field Trip",
        "id": "c_5ecbfbe91455ded71e86a87c1c0682e6122501a9aa76bdf952dfc78f191d8317@group.calendar.google.com",
    },
    "external": {
        "name": "VanaM_External Meeting",
        "id": "c_d1a487a560b2751048faca934a5003ad78be9eae96d671772afa8a71e86be38b@group.calendar.google.com",
    },
    "onsite": {
        "name": "VanaM_Onsite Meeting",
        "id": "c_8df85a0aa4137a0c03255853c4947070f42708b34ce30e6128e1bc5627dd351d@group.calendar.google.com",
    },
}


@dataclass
class Config:
    # DB
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    # Google Calendar 도메인 위임
    subject_email: str
    key_file: str
    # 동기화 / 읽기 범위
    sync_interval: int
    read_days_ahead: int
    # 로깅
    log_level: str
    log_file: str


def load_config() -> Config:
    db_host = os.environ.get("CALENDAR_DB_HOST", "inventory-web-postgres")
    db_port_raw = os.environ.get("CALENDAR_DB_PORT", "5432")
    db_name = os.environ.get("CALENDAR_DB_NAME")
    db_user = os.environ.get("CALENDAR_DB_USER")
    db_password = os.environ.get("CALENDAR_DB_PASSWORD")
    subject_email = os.environ.get("CALENDAR_SUBJECT_EMAIL")
    key_file = os.environ.get(
        "CALENDAR_KEY_FILE", "/app/secrets/service-account-key.json"
    )
    sync_interval_raw = os.environ.get("CALENDAR_SYNC_INTERVAL", "1800")
    read_days_ahead_raw = os.environ.get("CALENDAR_READ_DAYS_AHEAD", "7")

    missing = []
    if not db_host:
        missing.append("CALENDAR_DB_HOST")
    if not db_name:
        missing.append("CALENDAR_DB_NAME")
    if not db_user:
        missing.append("CALENDAR_DB_USER")
    if db_password is None or db_password == "":
        missing.append("CALENDAR_DB_PASSWORD")
    if not subject_email:
        missing.append("CALENDAR_SUBJECT_EMAIL")
    if missing:
        raise SystemExit(
            f"환경변수 누락: {', '.join(missing)}. .env 확인 필요."
        )

    try:
        db_port = int(db_port_raw)
    except ValueError:
        raise SystemExit(
            f"CALENDAR_DB_PORT가 정수가 아닙니다: {db_port_raw}"
        )

    try:
        sync_interval = int(sync_interval_raw)
    except ValueError:
        raise SystemExit(
            f"CALENDAR_SYNC_INTERVAL이 정수가 아닙니다: {sync_interval_raw}"
        )

    try:
        read_days_ahead = int(read_days_ahead_raw)
    except ValueError:
        raise SystemExit(
            f"CALENDAR_READ_DAYS_AHEAD가 정수가 아닙니다: {read_days_ahead_raw}"
        )

    return Config(
        db_host=db_host,
        db_port=db_port,
        db_name=db_name,
        db_user=db_user,
        db_password=db_password,
        subject_email=subject_email,
        key_file=key_file,
        sync_interval=sync_interval,
        read_days_ahead=read_days_ahead,
        log_level=os.environ.get("CALENDAR_LOG_LEVEL", "INFO"),
        log_file=os.environ.get("CALENDAR_LOG_FILE", "/app/logs/calendar-syncer.log"),
    )
