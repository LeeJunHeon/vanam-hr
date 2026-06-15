import nodemailer from "nodemailer";

// SMTP 설정(.env). 미설정이면 발송 스킵(앱 알림 등 본업은 정상).
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) return null; // 미설정 → 스킵
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false, // STARTTLS (587)
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    });
  }
  return transporter;
}

// 메일 1통 발송. 성공 true, 스킵/실패 false. 예외는 잡아서 로그만(호출부 흐름 유지).
export async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    console.debug(`[email] SMTP 미설정 — 발송 스킵 (to=${to})`);
    return false;
  }
  if (!to) return false;
  try {
    await t.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      text: body,
    });
    console.log(`[email] 발송 완료: to=${to}, subject=${subject}`);
    return true;
  } catch (e) {
    console.error(`[email] 발송 실패 (to=${to}): ${e}`);
    return false;
  }
}
