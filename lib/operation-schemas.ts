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
];
