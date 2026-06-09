"""SMTP 메일 알림 (근무중 끊김 통보).

스레드/I/O 안전: 모든 예외를 잡아 로그만 남기고 False를 반환.
aggregator 메인 루프가 절대 멈추지 않게 한다.
SMTP 설정(host/user/password)이 비어 있으면 발송 자체를 스킵.
"""

import smtplib
from email.message import EmailMessage


class EmailNotifier:
    def __init__(self, host: str, port: int, user: str, password: str, sender: str, logger):
        self.host = host
        self.port = port
        self.user = user
        self.password = password
        self.sender = sender or user
        self.logger = logger

    def send(self, to_email: str, subject: str, body: str) -> bool:
        """메일 1통 발송. 성공 시 True. 실패/스킵 시 False."""
        # SMTP 미설정 시 발송 스킵 (aggregator 본업은 계속)
        if not self.host or not self.user or not self.password:
            self.logger.debug(
                f"[notifier] SMTP 미설정 — 발송 스킵 (to={to_email}, subject={subject})"
            )
            return False
        if not to_email:
            self.logger.debug(f"[notifier] 수신자 이메일 없음 — 스킵 (subject={subject})")
            return False
        if not self.sender:
            self.logger.warning("[notifier] sender 비어있음 — 발송 스킵")
            return False

        try:
            msg = EmailMessage()
            msg["Subject"] = subject
            msg["From"] = self.sender
            msg["To"] = to_email
            msg.set_content(body)

            with smtplib.SMTP(self.host, self.port, timeout=10) as smtp:
                smtp.ehlo()
                try:
                    smtp.starttls()
                    smtp.ehlo()
                except smtplib.SMTPException as e:
                    # STARTTLS를 지원하지 않는 서버일 수도 있음 — 로그만 남기고 계속
                    self.logger.debug(f"[notifier] starttls 실패 (계속 진행): {e}")
                smtp.login(self.user, self.password)
                smtp.send_message(msg)
            self.logger.info(
                f"[notifier] 메일 발송 완료: to={to_email}, subject={subject}"
            )
            return True
        except Exception as e:
            # 모든 예외 흡수 — aggregator 메인 루프 절대 중단 금지
            self.logger.error(
                f"[notifier] 메일 발송 실패 (to={to_email}, subject={subject}): {e}"
            )
            return False
