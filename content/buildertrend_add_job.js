/**
 * Filling in Buildertrend's new-job page.
 *
 * This is v1's add_job.js, moved and changed as little as possible, and that is
 * a decision rather than an oversight. Whether ASH keeps Buildertrend is
 * undecided — the web app exists to replace the billing work that is the only
 * reason Buildertrend is in the picture — so the selectors and waits below are
 * expensive knowledge about a system that may be switched off. Rewriting them
 * would mean re-earning every timing quirk against a live account, for a coin
 * flip. The comments explaining *why* each wait exists are v1's and are kept
 * verbatim where they were right.
 *
 * What changed:
 *
 * 1. **The tenant facts arrive in the message.** Job type, job group, client
 *    name and the client's contact row id used to be literals in this file —
 *    the row id inside a CSS selector — so changing which company ASH bills
 *    meant editing source. They now come from the extension's settings.
 * 2. **A non-ready page reports itself as such** (ADD_JOB_PAGE_PROBLEM), so the
 *    service worker's handshake can stop waiting instead of burning fifty
 *    seconds on a page that has already said it is signed out.
 * 3. **Dequeuing goes through the service worker's own queue message** rather
 *    than a bespoke FILL_JOB_COMPLETE the background had to special-case.
 * 4. **The job-group loop's `break` bug is fixed.** It sat at the end of the
 *    first iteration unconditionally, so only the first chip was ever checked
 *    and a job already tagged Appfolio was tagged again.
 *
 * 5. **simulateInputTyping goes through the native property setter.** It used
 *    to assign `input.value` directly, which React's value tracker cannot see —
 *    so Ant Design's controlled fields reverted on the next render and the form
 *    held something other than what was on screen. That was the cause of the
 *    recurring "field resetting" reports, and it was deliberately left unfixed
 *    while this page's future was undecided. It is decided: Buildertrend is
 *    ASH's system of record for non-Camelot work.
 */

(() => {
  if (typeof browser === "undefined") globalThis.browser = chrome;

  const content = {
    auth_local_storage_key: "bt-object-previousAuthStoreInfo",
    current_fill_request: null,
    page_state_promise: null,

    /** Filled from the message; these are only fallbacks. */
    config: {
      job_type: "Handyman Services",
      job_group: "Appfolio",
      bt_client_name: "Camelot Properties",
      bt_client_row_id: "39778241",
    },

    init: async function () {
      this.allowClicks(false);

      try {
        const state = await this.pageState();

        if (state === "ready") {
          this.sendMessage("ADD_JOB_PAGE_READY");
          return;
        }

        // Two messages on purpose. The problem signal lets the service worker
        // stop waiting immediately; the text is what a person needs to read.
        this.sendMessage("ADD_JOB_PAGE_PROBLEM", state);
        this.sendCriticalErrorMessage(
          this.page_state_messages[state] ||
            this.page_state_messages.unconfirmed,
        );
      } finally {
        this.allowClicks(true);
      }
    },

    // Memoized so a status request from the background reuses the verdict
    // instead of starting a second wait.
    pageState: function () {
      if (!this.page_state_promise) {
        this.page_state_promise = this.determinePageState().catch(
          () => "unconfirmed",
        );
      }

      return this.page_state_promise;
    },

    // Positive proof the app shell rendered. Any one of these is enough:
    // insisting on a single selector turns one slow render into a bogus
    // "you're not logged in".
    ready_signals: [
      "[data-testid='bt-main-navigation']",
      "[data-testid='accountingLinkingCard']",
      "#item-header-title",
    ],

    // Affirmative proof the session is gone. The ABSENCE of a ready signal is
    // never treated as proof of this - that is almost always just a slow load.
    signed_out_signals: [
      "input[type='password']",
      "[data-testid='sessionExpired']",
      "[data-testid='login-form']",
    ],

    outage_signature: "our systems are currently unavailable",

    page_state_messages: {
      "signed-out":
        "You appear to be signed out of Buildertrend. Please log in and try again.",
      outage:
        "Buildertrend reports that its systems are currently unavailable. Please try again later.",
      loading:
        "The Buildertrend job page did not finish loading in time. Please reload the page and try again.",
      unconfirmed:
        "Unable to confirm your Buildertrend session. Please check that you're logged in, then reload the page.",
    },

    determinePageState: async function (timeout = 45000) {
      const state = await this.pollUntil(
        () => {
          for (const selector of this.signed_out_signals) {
            if (this.isElementVisible(document.querySelector(selector)))
              return "signed-out";
          }

          if (this.hasOutageMessage()) return "outage";

          for (const selector of this.ready_signals) {
            if (document.querySelector(selector)) return "ready";
          }

          return null;
        },
        { timeout, interval: 250 },
      );

      if (state) return state;

      // Nothing conclusive. The cached auth store is only a hint, so it is used
      // to pick the wording - never to declare the user logged out on its own.
      return this.readAuthUsername() ? "loading" : "unconfirmed";
    },

    hasOutageMessage: function () {
      for (const typography of document.querySelectorAll(".ant-typography")) {
        const message = typography.textContent || "";
        if (message.includes(this.outage_signature)) return true;
      }

      return false;
    },

    // Never throws: a malformed auth blob used to reject init() outright, which
    // left the popup waiting on a handshake that could no longer arrive.
    readAuthUsername: function () {
      try {
        const raw = localStorage.getItem(this.auth_local_storage_key);
        if (!raw) return "";

        const data = JSON.parse(raw);
        return typeof data?.username === "string" ? data.username : "";
      } catch {
        return "";
      }
    },

    // Always releases the page and the in-flight request, otherwise one failed
    // job leaves the tab refusing every job after it.
    fillOut: async function (work_order) {
      try {
        return await this.attemptFillOut(work_order);
      } catch (error) {
        this.sendCriticalErrorMessage(
          `Something went wrong while adding the job: ${
            error?.message || "Unexpected error."
          }`,
        );
        return false;
      } finally {
        this.current_fill_request = null;
        this.allowClicks(true);
      }
    },

    attemptFillOut: async function (work_order) {
      if (typeof work_order !== "object") throw new Error("Invalid work order");

      const workOrderNumber = work_order.number || "";
      const workOrderStreet = work_order.street || "";
      const workOrderCity = work_order.city || "";
      const workOrderState = work_order.state || "";
      const workOrderZip = work_order.zip || "";

      // The same convention the web app derives its title with, so a job has
      // one name in both systems: "(number) street".
      //
      // The prefix is set by the service worker for one of Dustin's test work
      // orders, and only there. Buildertrend has no test mode, so a job built
      // from a sample is a real job in the same list as everything else, and
      // its name is the only thing that will let anybody find them all again
      // and delete them. Decided in background/buildertrend.js against a scope
      // read from the server at the moment of filling, never here.
      const titlePrefix = work_order.title_prefix || "";
      const jobTitle = titlePrefix + "(" + workOrderNumber + ") " + workOrderStreet;
      const jobType = this.config.job_type;
      const jobGroup = this.config.job_group;
      const jobClient = this.config.bt_client_name;
      const jobClientRowId = this.config.bt_client_row_id;

      this.allowClicks(false);

      /**
       * The Quickbooks widget wait, currently vestigial.
       *
       * Filling the fields before this widget loads makes Buildertrend wipe
       * them, so v1 waited for it and refused without it. The widget then
       * disappeared from Buildertrend's side, so the refusal was commented out
       * — but the wait was left at its full ten seconds, which every job then
       * paid for nothing.
       *
       * Kept as a short wait rather than deleted, because if the widget comes
       * back the field-wiping comes back with it. Restoring the check means
       * restoring this timeout too.
       */
      await this.queryElement(
        "[data-testid='accountingLinkingCard'] img.quickbooks-logo",
        2500,
      );

      const inputJobTitleIdSelector = "#item-header-title";
      const inputJobTitle = await this.queryElement(inputJobTitleIdSelector);
      if (!inputJobTitle) {
        this.sendCriticalErrorMessage("Unable to find Job Title field.");
        return false;
      }

      const inputJobTypeIdSelector =
        ".ant-select-selector:has(#jobInfo\\.groupedProjectType)";
      const inputJobType = await this.queryElement(inputJobTypeIdSelector);
      if (!inputJobType) {
        this.sendCriticalErrorMessage("Unable to find Job Type field.");
        return false;
      }

      const inputJobGroupSelector =
        "[data-testid='jobGroup']:has(#jobInfo\\.jobGroups) .ant-select-selector";
      const inputJobGroup = await this.queryElement(inputJobGroupSelector);
      if (!inputJobGroup) {
        this.sendCriticalErrorMessage("Unable to find Job Group field.");
        return false;
      }

      const inputJobStreetSelector = "#jobInfo\\.address\\.street";
      const inputJobStreet = await this.queryElement(inputJobStreetSelector);
      if (!inputJobStreet) {
        this.sendCriticalErrorMessage("Unable to find Street field.");
        return false;
      }

      const inputJobCitySelector = "#jobInfo\\.address\\.city";
      const inputJobCity = await this.queryElement(inputJobCitySelector);
      if (!inputJobCity) {
        this.sendCriticalErrorMessage("Unable to find City field.");
        return false;
      }

      const inputJobStateSelector = "#jobInfo\\.address\\.state";
      const inputJobState = await this.queryElement(inputJobStateSelector);
      if (!inputJobState) {
        this.sendCriticalErrorMessage("Unable to find State field.");
        return false;
      }

      const inputJobZipSelector = "#jobInfo\\.address\\.zip";
      const inputJobZip = await this.queryElement(inputJobZipSelector);
      if (!inputJobZip) {
        this.sendCriticalErrorMessage("Unable to find Zip field.");
        return false;
      }

      // dirty work

      // job title
      this.simulateClick(inputJobTitle);
      this.simulateInputBackspace(inputJobTitle, inputJobTitle.value);
      this.simulateInputTyping(inputJobTitle, jobTitle);
      this.simulateClick(document.body);

      // job type
      this.simulateClick(inputJobType);
      this.simulateInputTyping(inputJobType, jobType);
      const jobTypeOption = await this.queryElement(
        `[data-searchvalue='${jobType}']`,
      );
      if (!jobTypeOption) {
        this.sendCriticalErrorMessage(`Unable to find the "${jobType}" job type.`);
        return false;
      }
      this.simulateClick(jobTypeOption);

      // job group
      //
      // Every chip is checked, not just the first. v1 had an unconditional
      // `break` at the end of the first iteration, so a job already tagged
      // Appfolio read as untagged and got tagged a second time.
      let appfolioTagged = false;
      const groupSelected = document.querySelectorAll(
        "[data-testid='jobGroup'] .ant-select-selection-overflow-item",
      );
      for (const group of groupSelected) {
        if ((group.textContent || "").trim() === jobGroup) {
          appfolioTagged = true;
          break;
        }
      }

      if (!appfolioTagged) {
        this.simulateClick(inputJobGroup);
        const jobGroupOption = await this.queryElement(
          `[data-testid='jobGroup-popup'] .ant-select-tree-list-holder-inner .ant-select-tree-treenode [title='${jobGroup}']`,
        );
        if (!jobGroupOption) {
          this.sendCriticalErrorMessage(
            `Unable to find the "${jobGroup}" job group.`,
          );
          return false;
        }
        this.simulateClick(jobGroupOption);
        this.simulateClick(document.body);
      }

      // job street
      this.simulateClick(inputJobStreet);
      this.simulateInputBackspace(inputJobStreet, inputJobStreet.value);
      this.simulateInputTyping(inputJobStreet, workOrderStreet);
      this.simulateClick(document.body);

      // job city
      this.simulateClick(inputJobCity);
      this.simulateInputBackspace(inputJobCity, inputJobCity.value);
      this.simulateInputTyping(inputJobCity, workOrderCity);
      this.simulateClick(document.body);

      // job state
      this.simulateClick(inputJobState);
      this.simulateInputBackspace(inputJobState, inputJobState.value);
      this.simulateInputTyping(inputJobState, workOrderState);
      this.simulateClick(document.body);

      // job zip
      this.simulateClick(inputJobZip);
      this.simulateInputBackspace(inputJobZip, inputJobZip.value);
      this.simulateInputTyping(inputJobZip, workOrderZip);
      this.simulateClick(document.body);

      await new Promise((resolve) => setTimeout(resolve, 1000));

      // next page

      // client page
      const clientPageButton = await this.queryElement("div#rc-tabs-0-tab-2");
      if (!clientPageButton) {
        this.sendCriticalErrorMessage("Unable to find client tab.");
        return false;
      }
      this.simulateClick(clientPageButton);

      // add existing client
      const existingContactAnchor = await this.queryElement(
        "button#searchContactInfoEmptyState",
      );
      if (!existingContactAnchor) {
        this.sendCriticalErrorMessage("Unable to add existing client.");
        return false;
      }
      this.simulateClick(existingContactAnchor);

      // search client name
      const inputNameSearchSelector = "input#nameSearch";
      const inputNameSearch = await this.queryElement(inputNameSearchSelector);
      const buttonNameSearch = await this.queryElement(
        inputNameSearchSelector +
          " + span.ant-input-group-addon button.ant-input-search-button",
      );
      if (!inputNameSearch || !buttonNameSearch) {
        this.sendCriticalErrorMessage(
          "Unable to search existing client. Cannot find search field / button",
        );
        return false;
      }
      this.simulateClick(inputNameSearch);
      this.simulateInputBackspace(inputNameSearch, inputNameSearch.value);
      this.simulateInputTyping(inputNameSearch, jobClient);
      this.simulateClick(buttonNameSearch);

      // select client
      //
      // The row id comes from settings now. It is Buildertrend's own contact id
      // for the client, and there is no way to find it from the name alone
      // without trusting whichever row happens to come back first — which for a
      // billing record is worse than requiring it be configured once.
      const buttonJobClient = await this.queryElement(
        `.ContactSearch-Table tr[data-row-key='${jobClientRowId}'] button[data-testid='select']`,
      );
      if (!buttonJobClient) {
        this.sendCriticalErrorMessage(
          `Unable to select "${jobClient}". Check the Buildertrend client row id in the extension's settings.`,
        );
        return false;
      }
      this.simulateClick(buttonJobClient);

      const saveButton = await this.queryElement(
        "[data-testid='bt-item-header-action-buttons-overflow'] button[data-testid='save']",
      );
      if (!saveButton) {
        this.sendCriticalErrorMessage("Unable to save job.");
        return false;
      }

      // check for success / error

      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Anything already on screen belongs to an earlier action, so it must not
      // be mistaken for the outcome of this save.
      const staleOutcomes = new WeakSet(this.querySaveOutcomeNodes());

      this.simulateClick(saveButton);

      const outcome = await this.waitForSaveOutcome(staleOutcomes);

      if (outcome.result === "success") {
        // The job already exists in Buildertrend at this point, so a messaging
        // hiccup here must not be reported as a failed save.
        try {
          await browser.runtime.sendMessage({
            type: "UNQUEUE_FROM_BT",
            payload: { numbers: [workOrderNumber] },
          });
        } catch {
          this.sendFlashMessage(
            "error",
            `${workOrderNumber} was added but could not be removed from the queue.`,
          );
        }

        this.sendFlashMessage("alert", `${workOrderNumber} successfully added.`);
        return true;
      }

      if (outcome.result === "error") {
        this.sendCriticalErrorMessage(
          outcome.message
            ? `Unable to save job: ${outcome.message}`
            : "Unable to save job.",
        );
        return false;
      }

      this.sendCriticalErrorMessage(
        `Unable to confirm whether ${workOrderNumber} was saved. Please check Buildertrend before trying again.`,
      );
      return false;
    },

    // Signals that reveal how the save went. Ordered by trust: an explicit
    // message beats the fallback navigation check.
    save_outcome_signals: [
      { result: "success", selector: ".ant-message-success" },
      { result: "error", selector: ".ant-message-error" },
      { result: "error", selector: "[data-testid='requiredCorrections']" },
      { result: "error", selector: ".ant-form-item-explain-error" },
    ],

    querySaveOutcomeNodes: function () {
      const selector = this.save_outcome_signals
        .map((signal) => signal.selector)
        .join(",");

      return document.querySelectorAll(selector);
    },

    // Polls every signal together so a failure is reported the moment it shows
    // up instead of after the success check has timed out.
    waitForSaveOutcome: function (ignore, timeout = 20000) {
      const ignored = ignore instanceof WeakSet ? ignore : new WeakSet();

      return this.pollUntil(
        () => {
          for (const signal of this.save_outcome_signals) {
            for (const node of document.querySelectorAll(signal.selector)) {
              if (ignored.has(node)) continue;
              if (!this.isElementVisible(node)) continue;

              return {
                result: signal.result,
                message: this.readMessage(node),
              };
            }
          }

          // A saved job gets its own id, so leaving the "new job" page (id 0)
          // is itself proof the save went through.
          const jobPageId = location.pathname.match(/\/JobPage\/(\d+)/i);
          if (jobPageId && jobPageId[1] !== "0")
            return { result: "success", message: "" };

          return null;
        },
        { timeout, fallback: { result: "unknown", message: "" } },
      );
    },

    // Re-reads the page until `read` returns something truthy. Polling rather
    // than a one-shot query is what keeps a slow render from being mistaken for
    // a verdict.
    pollUntil: function (
      read,
      { timeout = 20000, interval = 200, fallback = null } = {},
    ) {
      if (typeof read !== "function") throw new Error("Invalid reader.");

      return new Promise((resolve) => {
        const settle = (result) => {
          clearInterval(poller);
          clearTimeout(timer);
          resolve(result);
        };

        const check = () => {
          let result = null;
          try {
            result = read();
          } catch {
            result = null;
          }
          if (result) settle(result);
        };

        const poller = setInterval(check, interval);
        const timer = setTimeout(() => settle(fallback), timeout);

        check();
      });
    },

    isElementVisible: function (element) {
      if (!(element instanceof Element)) return false;
      if (!element.isConnected) return false;

      const hasBox =
        element.offsetWidth > 0 ||
        element.offsetHeight > 0 ||
        element.getClientRects().length > 0;
      if (!hasBox) return false;

      // Ant toasts fade out rather than unmount, so a fading node is history.
      const style = window.getComputedStyle(element);
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.opacity !== "0"
      );
    },

    readMessage: function (element) {
      if (!(element instanceof Element)) return "";

      const message = (element.textContent || "").replace(/\s+/g, " ").trim();
      return message.length > 200 ? `${message.slice(0, 200)}…` : message;
    },

    queryElement: function (selector, timeout = 10000) {
      if (typeof selector !== "string") throw new Error("Invalid selector.");
      if (typeof timeout !== "number") throw new Error("Invalid timeout.");

      let element = document.querySelector(selector);
      if (element) return Promise.resolve(element);

      return new Promise((resolve) => {
        const observer = new MutationObserver((mutationsList, obs) => {
          element = document.querySelector(selector);

          if (element) {
            obs.disconnect();
            clearTimeout(timer);
            resolve(element);
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        const timer = setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeout);
      });
    },

    allowClicks: function (bool) {
      if (typeof bool !== "boolean") throw new Error("Invalid boolean.");

      document.body.setAttribute("data-nss-processing", !bool);
    },

    // This used to write `input.value += char` directly, which bypasses React's
    // value tracker: the tracker then believes the field never changed and
    // reverts it on the next render, so the field looks filled and the form
    // holds something else. That was the cause of the recurring "field
    // resetting" reports, and it was left unfixed while Buildertrend's future
    // was undecided.
    //
    // It is decided: Buildertrend is ASH's system of record for non-Camelot
    // work, so it is staying, and a filler whose fields silently revert is not
    // something to build an estimates leg on top of.
    //
    // The per-character keydown/keyup loop is kept. The value now goes in once,
    // through the native setter, and the key events follow so that any handler
    // listening for typing still hears it — dispatching them is cheap and
    // removing them would be a second change in the same commit, against a live
    // account, with no way to test which of the two mattered.
    simulateInputTyping: function (input, string) {
      if (!(input instanceof Element)) throw new Error("Invalid input.");
      if (typeof string !== "string") throw new Error("Invalid string.");

      const prototype =
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;

      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

      for (const char of string) {
        const keydownEvent = new KeyboardEvent("keydown", {
          key: char,
          bubbles: true,
        });
        const inputEvent = new Event("input", { bubbles: true });
        const keyupEvent = new KeyboardEvent("keyup", {
          key: char,
          bubbles: true,
        });

        keydownEvent.synthetic = true;
        inputEvent.synthetic = true;
        keyupEvent.synthetic = true;

        input.dispatchEvent(keydownEvent);

        const next = String(input.value ?? "") + char;

        if (setter) setter.call(input, next);
        else input.value = next;

        input.dispatchEvent(inputEvent);
        input.dispatchEvent(keyupEvent);
      }

      input.dispatchEvent(new Event("change", { bubbles: true }));
    },

    simulateClick: function (element) {
      if (!(element instanceof Element)) throw new Error("Invalid element.");

      const mousedownEvent = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: window,
      });
      const mouseupEvent = new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        view: window,
      });
      const clickEvent = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      });

      mousedownEvent.synthetic = true;
      mouseupEvent.synthetic = true;
      clickEvent.synthetic = true;

      element.dispatchEvent(mousedownEvent);
      element.dispatchEvent(mouseupEvent);
      element.dispatchEvent(clickEvent);
    },

    simulateInputBackspace: function (input, string) {
      if (!(input instanceof Element)) throw new Error("Invalid input.");
      if (typeof string !== "string") throw new Error("Invalid string.");

      for (const char of string) {
        const keydownEvent = new KeyboardEvent("keydown", {
          key: "Backspace",
          code: "Backspace",
          keyCode: 8,
          which: 8,
          bubbles: true,
        });
        const inputEvent = new Event("input", { bubbles: true });
        const keyupEvent = new KeyboardEvent("keyup", {
          key: "Backspace",
          code: "Backspace",
          keyCode: 8,
          which: 8,
          bubbles: true,
        });

        keydownEvent.synthetic = true;
        inputEvent.synthetic = true;
        keyupEvent.synthetic = true;

        input.dispatchEvent(keydownEvent);
        input.value = input.value.slice(0, -1);
        input.dispatchEvent(inputEvent);
        input.dispatchEvent(keyupEvent);
      }
    },

    // Reporting must never throw: a closed popup has no listener, and losing the
    // report is not a reason to break the run that is reporting.
    sendMessage: function (type, payload) {
      try {
        const sending = browser.runtime.sendMessage({ type, payload });
        if (sending && typeof sending.catch === "function")
          sending.catch(() => {});
      } catch {
        // no receiver
      }
    },

    sendCriticalErrorMessage: function (string) {
      if (typeof string !== "string") throw new Error("Invalid string.");

      this.sendMessage("CRITICAL_ERROR", string);
    },

    sendFlashMessage: function (type, string) {
      if (typeof type !== "string") throw new Error("Invalid flash type.");
      if (typeof string !== "string") throw new Error("Invalid string.");

      switch (type) {
        case "alert":
          this.sendMessage("FLASH_ALERT", string);
          break;

        case "error":
          this.sendMessage("FLASH_ERROR", string);
          break;
      }
    },
  };

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Lets the background confirm the page is usable before asking it to fill,
    // including when the tab was already sitting on the add-job page.
    if (message.type === "ADD_JOB_PAGE_STATUS") {
      content.pageState().then((state) => sendResponse({ state }));
      return true;
    }

    if (message.type === "FILL_OUT_JOB") {
      if (content.current_fill_request) {
        content.sendCriticalErrorMessage(
          "There is an existing process request. Please wait until it's done.",
        );
        sendResponse({ accepted: false, error: "A fill is already running." });
        return;
      }

      const workOrder = message.payload?.work_order || null;
      if (!workOrder || !workOrder.number) {
        content.sendCriticalErrorMessage("Received an invalid work order.");
        sendResponse({ accepted: false, error: "Invalid work order." });
        return;
      }

      // The tenant facts, from the extension's settings. Merged over the
      // fallbacks so a missing key cannot leave a selector reading "undefined".
      content.config = { ...content.config, ...(message.payload?.config || {}) };

      // Answered right away rather than when the fill finishes - the request is
      // long running, and an unanswered port looks like a dead page.
      content.current_fill_request = workOrder;
      sendResponse({ accepted: true });

      content.fillOut(workOrder);
    }
  });

  // document_idle can run this script after "load" has already fired, in which
  // case waiting for the event means init() never runs and the background waits
  // forever on a handshake that will never be sent.
  if (document.readyState === "complete") {
    content.init();
  } else {
    window.addEventListener("load", () => content.init(), { once: true });
  }
})();
