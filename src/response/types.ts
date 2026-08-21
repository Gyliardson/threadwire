export type ResponseStreamEvent =
  | Readonly<{ type: "TEXT_DELTA"; text: string }>
  | Readonly<{ type: "COMPLETED" }>;
