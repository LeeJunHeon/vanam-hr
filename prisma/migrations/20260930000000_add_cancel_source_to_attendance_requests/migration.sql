-- AlterTable (배포 전 DBeaver 로 직접 실행 — prisma migrate 사용 안 함)
ALTER TABLE "hr"."attendance_requests" ADD COLUMN IF NOT EXISTS "cancel_source" VARCHAR(20);

COMMENT ON COLUMN "hr"."attendance_requests"."cancel_source" IS
  '취소 출처: user(웹에서 본인·관리자 취소) / calendar_sync(동기화가 캘린더에서 빠진 기록을 자동 취소). NULL = 취소 아님 또는 이전 기록';
