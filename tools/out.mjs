// Minimal stub; Task 2 extends this file.
export class VfError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "VfError";
    this.code = code;
    this.details = details;
  }
}
