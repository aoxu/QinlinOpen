import { BUILD, safeEntry, redact } from '../public/diagnostics.js';

export class DiagnosticLog {
  constructor(requestId, secrets = []) { this.requestId = requestId; this.secrets = secrets; this.entries = []; }
  protect(...values) { this.secrets.push(...values); }
  add(event, fields = {}) {
    this.entries.push(safeEntry({time:new Date().toISOString(),source:'worker',event,requestId:this.requestId,build:BUILD,...fields},this.secrets));
    if(this.entries.length > 30) this.entries.shift();
  }
  text(value) { return redact(value,this.secrets); }
  snapshot() { return this.entries.map(entry=>safeEntry(entry,this.secrets)); }
}
export function errorDetails(error) {
  return {errorName:error?.name ?? 'Error',errorMessage:error?.message ?? String(error),
    causeName:error?.cause?.name,causeMessage:error?.cause?.message,causeCode:error?.cause?.code};
}
