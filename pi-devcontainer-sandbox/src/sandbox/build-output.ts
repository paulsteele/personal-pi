import { stripTerminalSequences } from "@earendil-works/pi-tui";

export class StartupBuildOutput {
  private pendingLine = "";
  private cachedSteps = 0;

  constructor(private readonly output: (text: string) => void) {}

  write(text: string): void {
    const lines = (this.pendingLine + text).split(/\r\n|[\r\n]/);
    this.pendingLine = lines.pop()!;
    for (const line of lines) {
      this.emitLine(line);
    }
  }

  finish(): void {
    if (this.pendingLine) {
      this.emitLine(this.pendingLine);
      this.pendingLine = "";
    }
    if (this.cachedSteps) {
      this.output(`Reused ${this.cachedSteps} cached build steps.\n`);
      this.cachedSteps = 0;
    }
  }

  private emitLine(line: string): void {
    const content = stripTerminalSequences(line)
      .replace(/^\[[^\]]+\]\s*/, "")
      .trim();
    if (/^--> Using cache [a-f0-9]+$/.test(content)) {
      this.cachedSteps++;
      return;
    }
    const isImageIdentity = /^(?:--> )?(?:sha256:)?[a-f0-9]{12,64}$/.test(content);
    const isTagAnnouncement = /^Successfully tagged \S+$/.test(content);
    if (isImageIdentity || isTagAnnouncement) {
      return;
    }
    this.output(`${line}\n`);
  }
}
