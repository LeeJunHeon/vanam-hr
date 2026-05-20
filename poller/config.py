"""환경변수 로드 + Config dataclass 정의."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# 프로젝트 루트의 .env 로드 (poller/ 는 서브폴더이므로 부모 경로)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))


@dataclass
class Config:
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    snmp_community: str
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
    if missing:
        raise SystemExit(
            f"환경변수 누락: {', '.join(missing)}. .env 확인 필요."
        )

    try:
        db_port = int(db_port_raw)
    except ValueError:
        raise SystemExit(
            f"POLLER_DB_PORT가 정수가 아닙니다: {db_port_raw}"
        )

    return Config(
        db_host=db_host,
        db_port=db_port,
        db_name=db_name,
        db_user=db_user,
        db_password=db_password,
        snmp_community=community,
        log_level=os.environ.get("POLLER_LOG_LEVEL", "INFO"),
        log_file=os.environ.get("POLLER_LOG_FILE", "poller.log"),
        dry_run=os.environ.get("POLLER_DRY_RUN", "false").lower() == "true",
    )
