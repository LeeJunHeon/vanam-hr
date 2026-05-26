"""Google Chat Webhook 알림. 별도 스레드 fire-and-forget."""

import threading
import requests


class Notifier:
    """알림 발송. webhook_url이 None/빈 문자열이면 알림 비활성.

    별도 스레드로 동작하여 폴러 메인 루프에 영향 주지 않음.
    알림 실패 시 조용히 무시 (폴러는 계속 동작).
    """

    def __init__(self, webhook_url: str | None, logger=None):
        self.webhook_url = webhook_url
        self.logger = logger

    def send(self, message: str) -> None:
        """알림 발송 (즉시 리턴, 실제 HTTP는 별도 스레드)."""
        if not self.webhook_url:
            return
        threading.Thread(target=self._send_sync, args=(message,), daemon=True).start()

    def _send_sync(self, message: str) -> None:
        try:
            requests.post(
                self.webhook_url,
                json={"text": message},
                timeout=3,
            )
        except Exception as e:
            if self.logger:
                self.logger.warning(f"알림 발송 실패 (무시): {e}")
