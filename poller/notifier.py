"""Google Chat Webhook 알림. 별도 스레드 fire-and-forget + 실패 시 재전송 큐."""

import re
import threading
from collections import deque
from datetime import datetime

import requests

# 로그에 웹훅 자격증명이 남지 않도록 마스킹 (requests 예외 메시지에 URL이 통째로 포함됨)
_MASK_PATTERNS = [
    (re.compile(r"(key=)[^&\s'\"),]+"), r"\1***"),
    (re.compile(r"(token=)[^&\s'\"),]+"), r"\1***"),
    (re.compile(r"(/v1/spaces/)[^/\s'\"),]+"), r"\1***"),
]


class Notifier:
    """알림 발송. webhook_url이 None/빈 문자열이면 알림 비활성.

    별도 스레드로 동작하여 폴러 메인 루프에 영향 주지 않음.
    발송 실패 시 큐에 보관했다가 flush() 호출 시 재전송 (폴러는 계속 동작).
    """

    def __init__(
        self,
        webhook_url: str | None,
        logger=None,
        timeout: int = 3,
        queue_max: int = 50,
        queue_max_age_min: int = 60,
    ):
        self.webhook_url = webhook_url
        self.logger = logger
        self.timeout = timeout
        self.queue_max_age_min = queue_max_age_min
        self._queue: deque = deque(maxlen=queue_max)
        self._lock = threading.Lock()
        self._flushing = False

    @staticmethod
    def _mask(text: str) -> str:
        for pattern, repl in _MASK_PATTERNS:
            text = pattern.sub(repl, text)
        return text

    @property
    def queue_depth(self) -> int:
        with self._lock:
            return len(self._queue)

    def send(self, message: str) -> None:
        """알림 발송 (즉시 리턴, 실제 HTTP는 별도 스레드)."""
        if not self.webhook_url:
            return
        threading.Thread(target=self._send_sync, args=(message,), daemon=True).start()

    def flush(self) -> None:
        """큐에 밀린 알림 재전송 시도 (즉시 리턴, 실제 HTTP는 별도 스레드)."""
        if not self.webhook_url:
            return
        with self._lock:
            if not self._queue or self._flushing:
                return
            self._flushing = True
        threading.Thread(target=self._flush_sync, daemon=True).start()

    def _send_sync(self, message: str) -> None:
        ok, retryable = self._post(message)
        if not ok and retryable:
            self._enqueue(message)

    def _post(self, message: str) -> tuple[bool, bool]:
        """전송 시도. (성공여부, 재시도가치있음) 반환."""
        try:
            resp = requests.post(
                self.webhook_url,
                json={"text": message},
                timeout=self.timeout,
            )
            resp.raise_for_status()
            return True, False
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else 0
            retryable = status == 429 or status >= 500
            if self.logger:
                log = self.logger.warning if retryable else self.logger.error
                log(
                    f"알림 발송 실패 (HTTP {status}, "
                    f"{'재시도 예정' if retryable else '재시도 안 함 — 폐기'}): "
                    f"{self._mask(str(e))}"
                )
            return False, retryable
        except Exception as e:
            if self.logger:
                self.logger.warning(
                    f"알림 발송 실패 (네트워크, 재시도 예정): {self._mask(str(e))}"
                )
            return False, True

    def _enqueue(self, message: str) -> None:
        with self._lock:
            overflow = len(self._queue) >= self._queue.maxlen
            self._queue.append((datetime.now(), message))
            depth = len(self._queue)
        if self.logger:
            if overflow:
                self.logger.warning(f"알림 큐 초과 — 가장 오래된 항목 폐기 (큐 {depth}건)")
            else:
                self.logger.info(f"알림 큐 적재 (큐 {depth}건)")

    def _pop_if_head(self, message: str) -> None:
        with self._lock:
            if self._queue and self._queue[0][1] is message:
                self._queue.popleft()

    def _flush_sync(self) -> None:
        try:
            while True:
                with self._lock:
                    if not self._queue:
                        return
                    queued_at, message = self._queue[0]

                age_min = (datetime.now() - queued_at).total_seconds() / 60

                if age_min > self.queue_max_age_min:
                    self._pop_if_head(message)
                    if self.logger:
                        self.logger.warning(f"알림 큐 항목 만료 폐기 ({age_min:.0f}분 경과)")
                    continue

                prefixed = (
                    f"⏰ [지연 발송] 원래 발송 시각: {queued_at:%Y-%m-%d %H:%M:%S} KST "
                    f"({age_min:.0f}분 지연)\n{message}"
                )
                ok, retryable = self._post(prefixed)

                if ok:
                    self._pop_if_head(message)
                    if self.logger:
                        self.logger.info(
                            f"알림 지연 발송 성공 ({age_min:.0f}분 지연, "
                            f"잔여 {self.queue_depth}건)"
                        )
                    continue

                if retryable:
                    if self.logger:
                        self.logger.info(
                            f"알림 큐 재전송 실패 — 다음 사이클 재시도 (큐 {self.queue_depth}건)"
                        )
                    return
                self._pop_if_head(message)
        finally:
            with self._lock:
                self._flushing = False
