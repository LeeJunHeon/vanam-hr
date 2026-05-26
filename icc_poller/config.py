"""환경변수 로드 + Config dataclass 정의 (ICC 폴러용)."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# 프로젝트 루트의 .env 로드
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))


@dataclass
class Config:
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    icc_url: str
    icc_user: str
    icc_password: str
    icc_site_id: int
    log_level: str
    log_file: str
    dry_run: bool


def load_config() -> Config:
    db_host = os.environ.get("POLLER_DB_HOST")
    db_port_raw = os.environ.get("POLLER_DB_PORT", "5432")
    db_name = os.environ.get("POLLER_DB_NAME")
    db_user = os.environ.get("POLLER_DB_USER")
    db_password = os.environ.get("POLLER_DB_PASSWORD")
    icc_url = os.environ.get("ICC_URL")
    icc_user = os.environ.get("ICC_USER")
    icc_password = os.environ.get("ICC_PASSWORD")
    icc_site_id_raw = os.environ.get("ICC_SITE_ID", "1")

    missing = []
    if not db_host:
        missing.append("POLLER_DB_HOST")
    if not db_name:
        missing.append("POLLER_DB_NAME")
    if not db_user:
        missing.append("POLLER_DB_USER")
    if not db_password:
        missing.append("POLLER_DB_PASSWORD")
    if not icc_url:
        missing.append("ICC_URL")
    if not icc_user:
        missing.append("ICC_USER")
    if not icc_password:
        missing.append("ICC_PASSWORD")
    if missing:
        raise SystemExit(f"필수 환경변수 누락: {', '.join(missing)}")

    return Config(
        db_host=db_host,
        db_port=int(db_port_raw),
        db_name=db_name,
        db_user=db_user,
        db_password=db_password,
        icc_url=icc_url.rstrip("/"),
        icc_user=icc_user,
        icc_password=icc_password,
        icc_site_id=int(icc_site_id_raw),
        log_level=os.environ.get("POLLER_LOG_LEVEL", "INFO"),
        log_file=os.environ.get("POLLER_LOG_FILE", "/app/logs/icc-poller.log"),
        dry_run=os.environ.get("POLLER_DRY_RUN", "false").lower() == "true",
    )
