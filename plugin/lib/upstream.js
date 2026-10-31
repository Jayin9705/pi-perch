"use strict";
// Shared error type. All model execution is in cli.js through perch acp.
class PerchError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "PerchError";
    this.status = options.status || 0;
    this.code = options.code || "perch_error";
    this.retryable = options.retryable === true;
    this.limit = options.limit || null;
  }
}
module.exports = {PerchError};
