"""환경변수 로드 + Config dataclass 정의."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# 프로젝트 루트의 .env 로드 (aggregator/ 는 서브폴더이므로 부모 경로)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))


@dataclass
class Config:
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    interval_seconds: int
    log_level: str
    log_file: str
    # 근무중 끊김 알림 메일 (SMTP) — 미설정이면 notifier가 발송 스킵, 본업은 정상 동작
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    smtp_from: str


def load_config() -> Config:
    db_host = os.environ.get("AGGREGATOR_DB_HOST")
    db_port_raw = os.environ.get("AGGREGATOR_DB_PORT", "5432")
    db_name = os.environ.get("AGGREGATOR_DB_NAME")
    db_user = os.environ.get("AGGREGATOR_DB_USER")
    db_password = os.environ.get("AGGREGATOR_DB_PASSWORD")
    interval_raw = os.environ.get("AGGREGATOR_INTERVAL_SECONDS", "60")

    missing = []
    if not db_host:
        missing.append("AGGREGATOR_DB_HOST")
    if not db_name:
        missing.append("AGGREGATOR_DB_NAME")
    if not db_user:
        missing.append("AGGREGATOR_DB_USER")
    if db_password is None or db_password == "":
        missing.append("AGGREGATOR_DB_PASSWORD")
    if missing:
        raise SystemExit(
            f"환경변수 누락: {', '.join(missing)}. .env 확인 필요."
        )

    try:
        db_port = int(db_port_raw)
    except ValueError:
        raise SystemExit(
            f"AGGREGATOR_DB_PORT가 정수가 아닙니다: {db_port_raw}"
        )

    try:
        interval_seconds = int(interval_raw)
    except ValueError:
        raise SystemExit(
            f"AGGREGATOR_INTERVAL_SECONDS가 정수가 아닙니다: {interval_raw}"
        )

    # SMTP는 선택값(미설정이면 notifier가 발송 스킵). missing 체크에 넣지 않는다.
    smtp_host = os.environ.get("SMTP_HOST", "")
    smtp_port_raw = os.environ.get("SMTP_PORT", "587")
    try:
        smtp_port = int(smtp_port_raw)
    except ValueError:
        # 값이 잘못돼도 본업은 계속 — 587 기본값으로 처리
        smtp_port = 587
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_password = os.environ.get("SMTP_PASSWORD", "")
    smtp_from = os.environ.get("SMTP_FROM", "") or smtp_user

    return Config(
        db_host=db_host,
        db_port=db_port,
        db_name=db_name,
        db_user=db_user,
        db_password=db_password,
        interval_seconds=interval_seconds,
        log_level=os.environ.get("AGGREGATOR_LOG_LEVEL", "INFO"),
        log_file=os.environ.get("AGGREGATOR_LOG_FILE", "aggregator.log"),
        smtp_host=smtp_host,
        smtp_port=smtp_port,
        smtp_user=smtp_user,
        smtp_password=smtp_password,
        smtp_from=smtp_from,
    )
