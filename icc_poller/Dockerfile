FROM python:3.13-slim
WORKDIR /app

# 패키지 설치
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 코드 복사
COPY . .

# 로그 디렉터리
RUN mkdir -p /app/logs

CMD ["python", "poller.py"]
