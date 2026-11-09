-- AlterTable (배포 전 DBeaver 로 직접 실행 — prisma migrate 사용 안 함)
ALTER TABLE "hr"."trip_participant_dates"
  ADD COLUMN IF NOT EXISTS "meeting_start_time" TIME(6),
  ADD COLUMN IF NOT EXISTS "meeting_end_time" TIME(6);

ALTER TABLE "hr"."trip_participant_dates"
  ADD CONSTRAINT "chk_trip_participant_dates_meeting" CHECK (
    ("meeting_start_time" IS NULL AND "meeting_end_time" IS NULL)
    OR ("meeting_start_time" IS NOT NULL AND "meeting_end_time" IS NOT NULL
        AND "start_time" IS NOT NULL AND "end_time" IS NOT NULL
        AND "meeting_start_time" < "meeting_end_time"
        AND "meeting_start_time" >= "start_time"
        AND "meeting_end_time" <= "end_time")
  );

COMMENT ON COLUMN "hr"."trip_participant_dates"."meeting_start_time" IS
  '실제 미팅 시각(선택). 있으면 구글 캘린더에 이 시간으로 표시. 근태는 start_time/end_time(이동 포함)을 사용';
COMMENT ON COLUMN "hr"."trip_participant_dates"."meeting_end_time" IS
  '실제 미팅 시각(선택). 있으면 구글 캘린더에 이 시간으로 표시. 근태는 start_time/end_time(이동 포함)을 사용';
