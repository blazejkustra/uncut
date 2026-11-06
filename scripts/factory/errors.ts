export class Escalation extends Error {
  readonly stage: string;

  constructor(stage: string, reason: string) {
    super(reason);
    this.stage = stage;
  }
}

export type HaltKind = "stopped" | "usage-limit";

export class Halt extends Error {
  readonly kind: HaltKind;

  constructor(kind: HaltKind) {
    super(kind);
    this.kind = kind;
  }
}
