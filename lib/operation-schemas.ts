// HR(근태) 챗봇 작업 정의. 재고/장비 operation-schemas.ts와 동일 형식.
export type FieldType = "id_ref" | "number" | "date" | "text" | "enum" | "barcode";

export interface SchemaField {
  name: string; label: string; type: FieldType; required: boolean;
  lookup?: string; validation?: string; auto?: "today" | "system_generate"; enumValues?: string[];
}
export interface SchemaStep { api: string; body: string[]; returns?: string; }
export interface OperationSchema {
  id: string; label: string; description: string; triggers: string[];
  app: "hr"; appliesWhen?: { categoryName: string };
  fields: SchemaField[]; steps: SchemaStep[]; cardTitle: string; cardShow: string[];
}

export const OPERATION_SCHEMAS: OperationSchema[] = [
  {
    id: "hr_leave_request",
    label: "근태 신청",
    description: "연차·반차·외근·출장·재택·병가 등 근태 신청을 생성한다. 시간 단위(시간연차/특정 시각 반차 등)면 시작/종료 시각을 함께 넣고, 종일이면 시각을 비운다. 결재선은 시스템이 자동 배정한다. 본인 명의로만 신청된다.",
    triggers: ["연차 쓸게", "휴가 신청", "연차 신청", "반차", "외근 신청", "출장 신청", "재택 신청", "병가", "근태 신청", "시간 연차", "오전 반차", "오후 반차"],
    app: "hr",
    fields: [
      { name: "category", label: "근태 항목", type: "enum", required: true,
        validation: "표시된 근태 항목 중 하나를 그대로 넣는다." },
      { name: "startDate", label: "시작일", type: "date", required: true,
        validation: "YYYY-MM-DD. '내일'·'다음주 월요일' 등은 [현재 시각] KST 기준 환산." },
      { name: "endDate", label: "종료일", type: "date", required: true,
        validation: "YYYY-MM-DD. 하루면 시작일과 동일하게." },
      { name: "startTime", label: "시작 시각", type: "text", required: false,
        validation: "HH:MM 24시간(예: 13:00). 시간 단위 근태일 때만. 종일이면 비운다. 시작/종료 시각은 함께 넣거나 함께 비운다." },
      { name: "endTime", label: "종료 시각", type: "text", required: false,
        validation: "HH:MM 24시간(예: 18:00). 시간 단위 근태일 때만. 종일이면 비운다. 시작/종료 시각은 함께 넣거나 함께 비운다." },
      { name: "reason", label: "사유", type: "text", required: false },
    ],
    steps: [
      { api: "POST /api/internal/create-request", body: ["category", "startDate", "endDate", "startTime", "endTime", "reason"] },
    ],
    cardTitle: "근태 신청 확인",
    cardShow: ["category", "startDate", "endDate", "startTime", "endTime", "reason"],
  },
  {
    id: "hr_correction",
    label: "근태정정",
    description: "특정 날짜의 출근/퇴근 시각을 정정 신청한다. 출근 시각·퇴근 시각 중 하나 이상 필요. 정정은 하루만 가능. 결재선은 시스템이 자동 배정. 본인 명의로만.",
    triggers: ["근태 정정", "출근 시간 정정", "퇴근 시간 정정", "출퇴근 정정", "시간 수정", "깜빡하고 안 찍었", "정정 신청"],
    app: "hr",
    fields: [
      { name: "correctionCategory", label: "정정 항목", type: "enum", required: true,
        validation: "표시된 정정 항목 중 하나를 그대로 넣는다. 항목이 하나뿐이면 그것을 넣는다." },
      { name: "date", label: "정정 날짜", type: "date", required: true,
        validation: "YYYY-MM-DD. '어제'·'오늘' 등은 [현재 시각] KST 기준으로 환산. 정정은 하루만." },
      { name: "checkIn", label: "정정 출근 시각", type: "text", required: false,
        validation: "HH:MM 24시간 형식(예: 09:00). 출근 시각 정정이 아니면 비운다." },
      { name: "checkOut", label: "정정 퇴근 시각", type: "text", required: false,
        validation: "HH:MM 24시간 형식(예: 18:00). 퇴근 시각 정정이 아니면 비운다. 출근/퇴근 중 최소 하나는 필요." },
    ],
    steps: [
      { api: "POST /api/internal/correct-attendance", body: ["correctionCategory", "date", "checkIn", "checkOut"] },
    ],
    cardTitle: "근태정정 확인",
    cardShow: ["correctionCategory", "date", "checkIn", "checkOut"],
  },
  {
    id: "hr_trip_create",
    label: "출장(이벤트) 생성",
    description:
      "여러 명이 참여할 수 있는 그룹 출장 이벤트를 생성한다. 주최자는 본인이며, 참석자 초대는 생성 후 별도로 한다. 본인의 단순 연차·외근 '신청'(hr_leave_request)과는 다르다 — 이건 출장 일정 자체를 '만드는' 작업이다.",
    triggers: ["출장 만들어", "출장 만들어줘", "출장 생성", "출장 일정 만들어", "출장 이벤트 만들어", "출장 잡아줘", "출장 등록해줘", "그룹 출장 만들어"],
    app: "hr",
    fields: [
      { name: "name", label: "출장명", type: "text", required: true,
        validation: "출장 제목. 예: '부산 고객사 방문'. 사용자가 안 밝히면 되묻는다." },
      { name: "location", label: "장소", type: "text", required: false,
        validation: "출장 장소. 사용자가 말하지 않으면 비워둔다(되묻지 않아도 됨)." },
      { name: "startDate", label: "시작일", type: "date", required: true,
        validation: "YYYY-MM-DD. '다음주 월요일' 등은 [현재 시각] KST 기준으로 환산한다." },
      { name: "endDate", label: "종료일", type: "date", required: true,
        validation: "YYYY-MM-DD. 하루짜리면 startDate와 같게 넣는다." },
      { name: "description", label: "설명", type: "text", required: false },
    ],
    steps: [
      { api: "POST /api/internal/create-trip", body: ["name", "location", "startDate", "endDate", "description"] },
    ],
    cardTitle: "출장 생성 확인",
    cardShow: ["name", "location", "startDate", "endDate"],
  },
  {
    id: "hr_trip_invite",
    label: "출장 참석자 초대",
    description:
      "이미 만들어진 그룹 출장에 다른 직원을 참석자로 초대한다. 초대받은 사람은 수락 시 참석 날짜를 직접 고른다(여기서는 날짜를 받지 않는다). 출장을 새로 '만드는' hr_trip_create와는 다르다.",
    triggers: ["출장에 초대", "출장 초대", "참석자 추가", "출장에 넣어줘", "출장 멤버 추가"],
    app: "hr",
    fields: [
      { name: "trip", label: "출장", type: "text", required: true,
        validation: "초대 대상 출장. 출장명(또는 일부)으로 말한다. 예: '부산 고객사 방문'. 어느 출장인지 불명확하면 되묻는다." },
      { name: "employee", label: "초대할 직원", type: "text", required: true,
        validation: "초대할 직원의 등록된 이름(영문) 또는 사번. 한글 이름은 인식이 안 될 수 있으니 영문 이름/사번 권장. 불명확하면 되묻는다." },
    ],
    steps: [
      { api: "POST /api/internal/invite-trip", body: ["trip", "employee"] },
    ],
    cardTitle: "출장 초대 확인",
    cardShow: ["trip", "employee"],
  },
  {
    id: "hr_approve",
    label: "근태 결재(승인/반려)",
    description:
      "본인 결재함의 대기 중인 근태 신청을 승인하거나 반려한다. 가능하면 먼저 my_approvals 조회로 대기 목록을 보여준 뒤, 사용자가 지정한 신청자(또는 '전체')의 신청을 처리한다. 본인이 결재자로 지정된 건만 처리되며 권한은 서버가 강제한다.",
    triggers: ["승인해줘", "반려해줘", "결재 승인", "결재 반려", "결재해줘", "이거 승인", "반려할게"],
    app: "hr",
    fields: [
      { name: "target", label: "결재 대상", type: "text", required: true,
        validation: "결재할 신청의 신청자 이름(영문 권장) 또는 '전체'(내 대기 건 모두 승인). 반려는 '전체' 불가 — 특정 신청자만. 불명확하면 되묻는다." },
      { name: "action", label: "동작", type: "enum", required: true, enumValues: ["승인", "반려"],
        validation: "사용자가 승인하려 하면 '승인', 반려하려 하면 '반려'." },
      { name: "rejectReason", label: "반려 사유", type: "text", required: false,
        validation: "반려일 때만 필수. 승인이면 비운다." },
    ],
    steps: [
      { api: "POST /api/internal/approve-request", body: ["target", "action", "rejectReason"] },
    ],
    cardTitle: "결재 확인",
    cardShow: ["target", "action", "rejectReason"],
  },
  {
    id: "hr_trip_respond",
    label: "출장 초대 응답",
    description: "본인이 초대받은 출장 초대에 응답한다. 출장명으로 본인의 초대 건을 찾는다. 수락 시 참석 날짜를 지정할 수 있고(미지정이면 출장 전체 기간 참석), 거부도 가능. 본인 명의로만.",
    triggers: ["출장 초대", "출장 거절", "출장 거부", "출장 안 가", "출장 참여", "초대 거절", "출장 수락", "출장 갈게", "출장 참석"],
    app: "hr",
    fields: [
      { name: "trip", label: "출장", type: "text", required: true,
        validation: "초대받은 출장명. 본인이 초대된 활성 출장 중에서 찾는다." },
      { name: "action", label: "응답", type: "enum", required: true, enumValues: ["수락", "거부"],
        validation: "참석/수락이면 '수락', 거절/안 간다면 '거부'." },
      { name: "attendDates", label: "참석 날짜", type: "text", required: false,
        validation: "수락 시에만. 참석할 날짜를 YYYY-MM-DD로, 여러 날이면 콤마로 구분(예: 2026-06-03,2026-06-04). 비우면 출장 전체 기간 참석. 모두 출장 기간 내여야 한다." },
    ],
    steps: [
      { api: "POST /api/internal/respond-trip-invite", body: ["trip", "action", "attendDates"] },
    ],
    cardTitle: "출장 초대 응답 확인",
    cardShow: ["trip", "action", "attendDates"],
  },
  {
    id: "hr_trip_approve",
    label: "출장 참여 결재",
    description: "본인이 결재자로 지정된 출장 참여 신청을 승인/반려한다. 출장명 + 대상(신청자 이름 또는 '전체') + 승인/반려. 반려는 사유 필수. 결재 권한은 시스템이 신원으로 검증한다.",
    triggers: ["출장 결재", "출장 승인", "출장 반려", "출장 참여 승인", "출장 참여 반려", "출장 신청 승인", "출장 신청 반려"],
    app: "hr",
    fields: [
      { name: "trip", label: "출장", type: "text", required: true,
        validation: "결재할 출장명. 활성 출장 중에서 찾는다." },
      { name: "target", label: "대상", type: "text", required: true,
        validation: "결재 대상 신청자 이름. 모두 처리하면 '전체'." },
      { name: "action", label: "결재", type: "enum", required: true, enumValues: ["승인", "반려"],
        validation: "승인 또는 반려." },
      { name: "rejectReason", label: "반려 사유", type: "text", required: false,
        validation: "반려일 때만 필수." },
    ],
    steps: [
      { api: "POST /api/internal/approve-trip", body: ["trip", "target", "action", "rejectReason"] },
    ],
    cardTitle: "출장 참여 결재 확인",
    cardShow: ["trip", "target", "action", "rejectReason"],
  },
];
