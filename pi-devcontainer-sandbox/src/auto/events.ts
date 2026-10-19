import type { AutoModeSnapshot, DecisionRecord } from "./core.ts";

export const AUTO_MODE_STATE_CHANNEL = "auto-mode:state";
export const AUTO_MODE_DECISION_CHANNEL = "auto-mode:decision";
export const AUTO_MODE_DISCOVER_CHANNEL = "auto-mode:discover";

export interface EventTransport {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

export function createAutoPublisher(events: EventTransport) {
  let snapshot: AutoModeSnapshot | undefined;
  const unsubscribe = events.on(AUTO_MODE_DISCOVER_CHANNEL, () => {
    if (snapshot) events.emit(AUTO_MODE_STATE_CHANNEL, snapshot);
  });
  return {
    update(next: AutoModeSnapshot) {
      snapshot = next;
      events.emit(AUTO_MODE_STATE_CHANNEL, next);
    },
    decision(record: DecisionRecord, toolCallId: string | null) {
      events.emit(AUTO_MODE_DECISION_CHANNEL, { ...record, toolCallId });
    },
    dispose() {
      unsubscribe();
      snapshot = undefined;
    },
  };
}
