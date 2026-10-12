export const SANDBOX_STATE_CHANNEL = "sandbox:state:v1";
export const SANDBOX_DISCOVER_CHANNEL = "sandbox:discover:v1";

export interface SandboxPresentation {
  version: 1;
  sessionId: string;
  revision: number;
  phase: "starting" | "ready" | "changing" | "unavailable" | "stopped";
  definitionPath: string;
  toolingSources?: string[];
  toolingRevision?: string;
  containerName?: string;
  containerId?: string;
  image?: string;
  cwd?: string;
  mounts: { source: string; destination: string; access: "ro" | "rw" }[];
  ports: number[];
  error?: string;
}

export function createSandboxPublisher(events: {
  on(channel: string, handler: (value: unknown) => void): () => void;
  emit(channel: string, value: unknown): void;
}) {
  let snapshot: SandboxPresentation | undefined;
  let revision = 0;
  const unsubscribe = events.on(SANDBOX_DISCOVER_CHANNEL, () => {
    if (snapshot) {
      events.emit(SANDBOX_STATE_CHANNEL, snapshot);
    }
  });
  return {
    update(value: Omit<SandboxPresentation, "version" | "revision">) {
      snapshot = { ...value, version: 1, revision: ++revision };
      events.emit(SANDBOX_STATE_CHANNEL, snapshot);
    },
    dispose: unsubscribe,
  };
}
