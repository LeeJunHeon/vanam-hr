"""환경변수 로드 + Config dataclass 정의 (calendar-syncer)."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# 프로젝트 루트의 .env 로드 (calendar-syncer/ 는 서브폴더이므로 부모 경로)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))


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
    log_level = os.environ.get("CALENDAR_LOG_LEVEL", "INFO")
    log_file = os.environ.get("CALENDAR_LOG_FILE", "/app/logs/calendar-syncer.log")

    # 필수 값 검증
    missing = []
    if not db_name:
        missing.append("CALENDAR_DB_NAME")
    if not db_user:
        missing.append("CALENDAR_DB_USER")
    if not db_password:
        missing.append("CALENDAR_DB_PASSWORD")
    if not subject_email:
        missing.append("CALENDAR_SUBJECT_EMAIL")
    if missing:
        raise RuntimeError(
            f"필수 환경변수 누락: {', '.join(missing)}. .env 파일 확인 필요."
        )

    try:
        db_port = int(db_port_raw)
    except ValueError:
        raise RuntimeError(f"CALENDAR_DB_PORT가 정수가 아님: {db_port_raw}")

    return Config(
        db_host=db_host,
        db_port=db_port,
        db_name=db_name,
        db_user=db_user,
        db_password=db_password,
        subject_email=subject_email,
        key_file=key_file,
        log_level=log_level,
        log_file=log_file,
    )
