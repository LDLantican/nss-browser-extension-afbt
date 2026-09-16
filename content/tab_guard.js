/**
 * Keeping a person's hands off a tab the extension is working in.
 *
 * Runs at document_start on every page an owned tab can be driven on, so its
 * listeners are registered before any of the page's own — a capturing listener
 * on `window` that was added first sees every event first.
 *
 * ## Why this does not get in the automation's way
 *
 * It blocks only events whose `isTrusted` is true, which are the ones a real
 * mouse, finger or keyboard produces. Everything the content scripts do —
 * `element.click()`, `dispatchEvent(new MouseEvent(...))`, `input` and `change`
 * events — produces untrusted events that are not hit-tested, so they pass
 * straight through the overlay and straight past these listeners.
 *
 * ## What it cannot do
 *
 * Stop the tab being closed, reloaded, or navigated from the address bar or
 * the Back button. No page can. The background notices a closed tab and stops
 * the run; see background/owned_tabs.js.
 *
 * ## It asks rather than trusts
 *
 * Whether to be locked is asked of the service worker on load and every few
 * seconds after. No answer means unlocked. A lock that outlived the run that
 * took it — a crashed worker, a reloaded extension — would leave somebody
 * staring at a page they cannot use with nothing behind it that will ever
 * finish.
 */

(() => {
  const POLL_MS = 3000;

  const BLOCKED = [
    "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick",
    "contextmenu", "touchstart", "touchmove", "touchend", "wheel", "keydown", "keypress",
    "keyup", "beforeinput", "paste", "cut", "drop", "dragstart",
  ];

  const guard = {
    locked: false,
    label: "",
    host: null,
    text: null,
    poll: null,

    block(event) {
      if (!event.isTrusted) return;

      event.preventDefault();
      event.stopImmediatePropagation();
    },

    apply(locked, label) {
      guard.label = String(label || "");

      if (locked === guard.locked) {
        if (guard.text) guard.text.textContent = guard.message();

        return;
      }

      guard.locked = locked;

      if (locked) {
        for (const type of BLOCKED)
          window.addEventListener(type, guard.block, { capture: true, passive: false });

        guard.show();
        guard.poll = setInterval(guard.ask, POLL_MS);

        return;
      }

      for (const type of BLOCKED) window.removeEventListener(type, guard.block, { capture: true });

      clearInterval(guard.poll);
      guard.poll = null;
      guard.hide();
    },

    message() {
      return guard.label === ""
        ? "NSS Helper is working in this tab. Please don't use it until it has finished."
        : `NSS Helper is working in this tab — ${guard.label}. Please don't use it until it has finished.`;
    },

    /**
     * On `<html>`, not `<body>`, and in a closed shadow root.
     *
     * The fillers watch `body` with MutationObservers and query the document
     * with selectors; neither can see into a closed shadow root, and nothing
     * they wait for can be triggered by an element outside `body`.
     */
    show() {
      if (guard.host) return;

      const host = document.createElement("nss-tab-guard");
      const root = host.attachShadow({ mode: "closed" });

      root.innerHTML = `
        <style>
          :host { all: initial; }
          .veil {
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            background: rgba(15, 23, 42, 0.12);
            cursor: wait;
          }
          .note {
            position: fixed;
            top: 12px;
            left: 50%;
            transform: translateX(-50%);
            max-width: min(36rem, calc(100vw - 32px));
            padding: 10px 14px;
            border-radius: 6px;
            background: #1e293b;
            color: #f8fafc;
            font: 600 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
          }
        </style>
        <div class="veil"><div class="note" role="status"></div></div>
      `;

      guard.text = root.querySelector(".note");
      guard.text.textContent = guard.message();
      guard.host = host;

      document.documentElement.appendChild(host);
    },

    hide() {
      guard.host?.remove();
      guard.host = null;
      guard.text = null;
    },

    async ask() {
      try {
        const answer = await chrome.runtime.sendMessage({ type: "TAB_GUARD_STATUS" });

        guard.apply(answer?.locked === true, answer?.label);
      } catch {
        guard.apply(false, "");
      }
    },

    /**
     * The page as it stands, for a report written just before the tab closes.
     *
     * With what was typed into it, and without anything that authenticates:
     * the saved vendor-portal captures hold live tokens, and a report is
     * something that gets pasted into a chat.
     */
    snapshot() {
      const LIMIT = 200000;
      const clone = document.documentElement.cloneNode(true);

      /* Current values onto attributes, while the two trees still line up
         element for element. A value somebody — or the filler — typed lives on
         the property, which outerHTML does not include. */
      const live = document.documentElement.querySelectorAll("input, textarea, select");
      const copies = clone.querySelectorAll("input, textarea, select");

      live.forEach((element, index) => {
        const copy = copies[index];
        if (!copy) return;

        const type = String(element.type || "").toLowerCase();

        if (type === "hidden" || type === "password" || type === "file") {
          copy.removeAttribute("value");

          return;
        }

        if (element.tagName === "TEXTAREA") copy.textContent = element.value;
        else if (element.tagName === "SELECT") copy.setAttribute("data-nss-value", element.value);
        else if (type === "checkbox" || type === "radio") {
          if (element.checked) copy.setAttribute("checked", "");
          else copy.removeAttribute("checked");
        } else copy.setAttribute("value", element.value);
      });

      clone
        .querySelectorAll("script, noscript, iframe, style, template, nss-tab-guard")
        .forEach((element) => element.remove());

      clone.querySelectorAll('meta[name*="csrf" i], meta[name*="token" i]').forEach((element) => element.remove());

      clone.querySelectorAll("svg").forEach((element) => element.replaceChildren());

      for (const element of clone.querySelectorAll("*"))
        for (const attribute of [...element.attributes])
          if (/token|csrf|secret|auth/i.test(attribute.name)) element.removeAttribute(attribute.name);

      const html = clone.outerHTML;

      return html.length > LIMIT ? `${html.slice(0, LIMIT)}\n<!-- truncated at ${LIMIT} characters -->` : html;
    },
  };

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "TAB_GUARD_SET") {
      guard.apply(message.payload?.locked === true, message.payload?.label);
      respond({ ok: true });

      return false;
    }

    if (message?.type === "TAB_SNAPSHOT") {
      try {
        respond({ html: guard.snapshot() });
      } catch (error) {
        respond({ error: String(error?.message || error) });
      }

      return false;
    }

    return false;
  });

  guard.ask();
})();
