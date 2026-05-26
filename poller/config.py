"""환경변수 로드 + Config dataclass 정의 (통합 폴러: 신도림 SNMP + 공덕 ICC)."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))


@dataclass
class Config:
    # DB
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    # 신도림 SNMP
    snmp_community: str
    # 공덕 ICC HTTP API
    icc_url: str
    icc_user: str
    icc_password: str
    icc_site_id: int
    # Google Chat Webhook (알림용, 선택적)
    notifier_webhook_url: str
    # 로깅/기타
    log_level: str
    log_file: str
    dry_run: bool


def load_config() -> Config:
    db_host = os.environ.get("POLLER_DB_HOST")
    db_port_raw = os.environ.get("POLLER_DB_PORT", "5432")
    db_name = os.environ.get("POLLER_DB_NAME")
    db_user = os.environ.get("POLLER_DB_USER")
    db_password = os.environ.get("POLLER_DB_PASSWORD")
    community = os.environ.get("SNMP_COMMUNITY")
    icc_url = os.environ.get("ICC_URL")
    icc_user = os.environ.get("ICC_USER")
    icc_password = os.environ.get("ICC_PASSWORD")
    icc_site_id_raw = os.environ.get("ICC_SITE_ID", "1")
    notifier_webhook = os.environ.get("NOTIFIER_WEBHOOK_URL", "")  # 선택적

    missing = []
    if not db_host:
        missing.append("POLLER_DB_HOST")
    if not db_name:
        missing.append("POLLER_DB_NAME")
    if not db_user:
        missing.append("POLLER_DB_USER")
    if db_password is None or db_password == "":
        missing.append("POLLER_DB_PASSWORD")
    if not community:
        missing.append("SNMP_COMMUNITY")
    if not icc_url:
        missing.append("ICC_URL")
    if not icc_user:
        missing.append("ICC_USER")
    if not icc_password:
        missing.append("ICC_PASSWORD")
    if missing:
        raise SystemExit(
            f"환경변수 누락: {', '.join(missing)}. .env 확인 필요."
        )

    try:
        db_port = int(db_port_raw)
    except ValueError:
        raise SystemExit(f"POLLER_DB_PORT가 정수가 아닙니다: {db_port_raw}")

    try:
        icc_site_id = int(icc_site_id_raw)
    except ValueError:
        raise SystemExit(f"ICC_SITE_ID가 정수가 아닙니다: {icc_site_id_raw}")

    return Config(
        db_host=db_host,
        db_port=db_port,
        db_name=db_name,
        db_user=db_user,
        db_password=db_password,
        snmp_community=community,
        icc_url=icc_url.rstrip("/"),
        icc_user=icc_user,
        icc_password=icc_password,
        icc_site_id=icc_site_id,
        notifier_webhook_url=notifier_webhook,
        log_level=os.environ.get("POLLER_LOG_LEVEL", "INFO"),
        log_file=os.environ.get("POLLER_LOG_FILE", "poller.log"),
        dry_run=os.environ.get("POLLER_DRY_RUN", "false").lower() == "true",
    )
