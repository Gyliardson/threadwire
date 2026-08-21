export type ResponseStreamTextDeltaEvent = Readonly<{
  type: "TEXT_DELTA";
  text: string;
}>;

export type NormalizedResponseStreamEvent =
  | ResponseStreamTextDeltaEvent
  | Readonly<{ type: "COMPLETED" }>;

export type ResponseStreamEvent =
  | ResponseStreamTextDeltaEvent
  | Readonly<{ type: "FINAL_TEXT"; text: string }>
  | Readonly<{ type: "COMPLETED" }>;
