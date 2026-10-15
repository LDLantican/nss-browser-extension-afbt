/**
 * What can go wrong with a job, in the words the server uses.
 *
 * The classes are the worker API's `error_class` vocabulary (docs/worker-api.md
 * in the web app, "fail"). An adapter says which one applies and the server
 * decides what follows — retried, routed to somebody else, or handed to a
 * person. Nothing on this side retries a job by itself; the queue does.
 */

export const TRANSIENT = "transient";
export const PERMANENT = "permanent";
export const PERMISSION = "permission";
export const SESSION_EXPIRED = "session_expired";
export const ADAPTER_BROKEN = "adapter_broken";
export const UNKNOWN_OUTCOME = "unknown_outcome";
export const VERIFIED_ABSENT = "verified_absent";

export const ERROR_CLASSES = [
  TRANSIENT,
  PERMANENT,
  PERMISSION,
  SESSION_EXPIRED,
  ADAPTER_BROKEN,
  UNKNOWN_OUTCOME,
  VERIFIED_ABSENT,
];

/**
 * An adapter's account of a step that did not work.
 *
 * Anything else an adapter throws — a TypeError, a selector that returned
 * null — is a bug in the adapter, and is reported as `adapter_broken` before
 * the commit point and `unknown_outcome` after it.
 */
export class AdapterError extends Error {
  constructor(error_class, message, { identity = null } = {}) {
    super(message);
    this.name = "AdapterError";
    this.error_class = ERROR_CLASSES.includes(error_class) ? error_class : ADAPTER_BROKEN;
    this.identity = identity;
  }
}

/**
 * The job's tab went away under it — a person closed it, or the browser did.
 *
 * Its own class because it is not the job's fault and not the platform's:
 * before the commit point nothing was written and the job is simply given
 * back; after it, nobody knows, which is what verification is for.
 */
export class TabGone extends Error {
  constructor(message = "The job's tab was closed.") {
    super(message);
    this.name = "TabGone";
  }
}

/** The web app could not be reached at all: offline, DNS, a timeout. */
export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * This browser is not signed in as a worker, or no longer is.
 *
 * `reason` is `signed_out` (nothing stored, or stored for another address),
 * `retired` (the device token was refused: retired at /account, or the account
 * switched off) or `unavailable` (the web app has no worker API, or refused the
 * exchange for another reason).
 */
export class NotSignedIn extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "NotSignedIn";
    this.reason = reason;
  }
}
