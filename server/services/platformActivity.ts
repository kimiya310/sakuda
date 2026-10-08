/** Live transport ownership is separate from persisted user-facing cancellation state. */
export const platformControllers = new Map<string, AbortController>()
