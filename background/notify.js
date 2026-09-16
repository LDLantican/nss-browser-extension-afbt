/**
 * Telling the manager something when the popup is not open.
 *
 * v1 had no notifications at all, and every outcome went to a flash list in the
 * popup — which closes the moment focus returns to the page. So the messages
 * were real, correct, and delivered to nothing: the actual way anybody learned
 * a job had gone through was noticing it had vanished from the queue.
 *
 * Two channels, deliberately different in weight. The toolbar badge is ambient
 * and always current — a count you can glance at. A notification is an
 * interruption and is only used when a batch finishes, never per row.
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

      /* Not required: a sync result is worth seeing, not worth demanding
         acknowledgement of while somebody is typing into Appfolio. */
      requireInteraction: false,
      silent: true,
    });
  } catch {
    /* Notifications can be switched off at the OS level, and a report that
       cannot be delivered must never break the run it was reporting on. */
  }
}

/**
 * The count on the toolbar icon.
 *
 * Rows needing a person win over rows still working, because a stuck conflict
 * matters more than a queue that is draining by itself — and red is the only
 * thing here that asks for attention rather than merely reporting.
 */
export function set_badge(counts) {
  const attention = counts?.attention || 0;
  const pending = counts?.pending || 0;

  const text = attention > 0 ? String(attention) : pending > 0 ? String(pending) : "";
  const colour = attention > 0 ? "#7f1d1d" : "#166534";

  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: colour });
  } catch {
    // Same reasoning as above.
  }
}

/**
 * Say once that this build may not deliver.
 *
 * The one-minute alarm discards a run's result, so without this an outdated
 * install would stop delivering in complete silence — every other manager's
 * browser would carry on, and nobody would know this one had dropped out.
 * Once per required version per browser session, not every minute: the alarm
 * repeats the refusal without anything having changed.
 */
const OUTDATED_KEY = "nss_outdated_notice";

export async function warn_outdated(body = {}) {
  const required = String(body?.required_version || "");
  let seen = null;

  try {
    ({ [OUTDATED_KEY]: seen } = await chrome.storage.session.get(OUTDATED_KEY));
  } catch {
    /* No record means saying it again, which is the harmless direction. */
  }

  if (seen === required) return;

  try {
    await chrome.storage.session.set({ [OUTDATED_KEY]: required });
  } catch {}

  notify("Extension update needed", outdated_reason(body));
}

/** The sentence a person reads, naming both versions when the web app sent them. */
export function outdated_reason(body = {}) {
  const required = body?.required_version;
  const yours = body?.your_version;

  if (!required)
    return "The web app has no extension version set, so this browser is not sending invoices or estimates.";

  return `This extension is ${yours ? `version ${yours}` : "an unknown version"} and the web app needs ${required}, `
    + "so this browser is not sending invoices or estimates. Update the extension and reload it.";
}
