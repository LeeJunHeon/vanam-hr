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
    description: "연차·반차·외근·출장·재택·병가 등 근태 신청을 생성한다. 결재선은 시스템이 자동 배정한다. 본인 명의로만 신청된다.",
    triggers: ["연차 쓸게", "휴가 신청", "연차 신청", "반차", "외근 신청", "출장 신청", "재택 신청", "병가", "근태 신청"],
    app: "hr",
    fields: [
      { name: "category", label: "근태 항목", type: "enum", required: true,
        validation: "표시된 근태 항목 중 사용자가 말한 것과 일치하는 하나를 그대로 넣는다. 불명확하면 되묻는다." },
      { name: "startDate", label: "시작일", type: "date", required: true,
        validation: "YYYY-MM-DD. '내일'·'다음주 월요일' 등은 [현재 시각] KST 기준으로 환산한다." },
      { name: "endDate", label: "종료일", type: "date", required: true,
        validation: "YYYY-MM-DD. 하루만 신청이면 startDate와 같게 넣는다." },
      { name: "reason", label: "사유", type: "text", required: false },
    ],
    steps: [
      { api: "POST /api/internal/create-request", body: ["category", "startDate", "endDate", "reason"] },
    ],
    cardTitle: "근태 신청 확인",
    cardShow: ["category", "startDate", "endDate", "reason"],
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
];
