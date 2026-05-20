FROM python:3.13-slim

WORKDIR /app

# 시스템 패키지:
# - libpq-dev: psycopg2-binary 백업용
# - libsnmp-dev, snmp: easysnmp 빌드 + snmpwalk CLI (디버깅용)
# - snmp-mibs-downloader: MIB 파일 (선택, easysnmp가 use_numeric=True라 사실상 불필요하나 안전)
# - build-essential, gcc: easysnmp wheel 미제공 시 컴파일
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    libsnmp-dev \
    snmp \
    snmp-mibs-downloader \
    build-essential \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 빌드 도구는 설치 후 제거 (이미지 크기 축소)
RUN apt-get purge -y build-essential gcc \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# 로그 디렉토리
RUN mkdir -p /app/logs

CMD ["python", "poller.py"]
