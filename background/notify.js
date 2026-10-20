/**
 * Telling a person something when the popup is not open.
 *
 * The popup closes the moment focus returns to the page, so anything worth
 * saying while it is shut — a job waiting for a press in the browser, say — is
 * a notification. It is an interruption, so it is used sparingly: the worker
 * sends one when a person has to act, never per step.
 */

const ICON = "icons/128.png";

/** One id, reused, so a second notification replaces the first. */
const ID = "nss-status";

export function notify(title, message) {
  try {
    chrome.notifications.create(ID, {
      type: "basic",
      iconUrl: ICON,
      title,
      message,

      /* Not required: worth seeing, not worth demanding acknowledgement of
         while somebody is typing into AppFolio. */
      requireInteraction: false,
      silent: true,
    });
  } catch {
    /* Notifications can be switched off at the OS level, and a report that
       cannot be delivered must never break the run it was reporting on. */
  }
}
