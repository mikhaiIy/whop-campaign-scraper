export interface ToolCallRecord {
  at: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error: string | null;
  durationMs: number;
}

const MAX = 200;

export class ToolLog {
  private items: ToolCallRecord[] = [];

  record(tool: string, args: Record<string, unknown>, ok: boolean, error: string | null, durationMs: number): void {
    this.items.unshift({ at: new Date().toISOString(), tool, args, ok, error, durationMs });
    if (this.items.length > MAX) this.items.length = MAX;
  }

  list(): ToolCallRecord[] { return [...this.items]; }
}
