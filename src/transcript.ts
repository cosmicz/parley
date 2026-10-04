/** Assemble Soniox token deltas without mistaking provisional words for finals. */
export class TranscriptAssembler {
  private finals = '';
  private provisional = '';

  get text(): string {
    return this.finals + this.provisional;
  }

  apply(msg: { tokens?: { text: string; is_final: boolean }[] }): string {
    let nextProvisional = '';
    for (const token of msg.tokens ?? []) {
      if (token.text === '<end>' || token.text === '<fin>') continue;
      if (token.is_final) this.finals += token.text;
      else nextProvisional += token.text;
    }
    this.provisional = nextProvisional;
    return this.text;
  }

  reset(): void {
    this.finals = '';
    this.provisional = '';
  }
}
