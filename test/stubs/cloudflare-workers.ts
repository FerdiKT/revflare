// Node unit tests import worker modules that extend these classes; nothing runs them.
export class DurableObject {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown,
  ) {}
}
export class WorkflowEntrypoint {}
