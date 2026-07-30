(() => {
  if (typeof browser === "undefined") globalThis.browser = chrome;

  const background = {
    work_orders: new Map(),

    // Tabs whose content script already reported a specific problem, so the
    // background does not stack a vaguer banner on top of it.
    reported_tabs: new Set(),

    add_job_url: "https://buildertrend.net/app/JobPage/0/1?openCondensed=true",
    add_job_path: "/app/JobPage/0/",

    fillJob: async function (message, sender) {
      const work_order = message.payload || null;
      if (typeof work_order !== "object")
        throw new Error("Invalid work order.");

      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id) {
        this.reportError("Unable to find the active tab. Please try again.");
        return;
      }

      this.reported_tabs.delete(tab.id);

      let ready = false;

      if (tab.url?.startsWith(this.add_job_url)) {
        ready = await this.confirmPageReady(tab.id);
      } else {
        // Both waits are armed before the navigation starts, otherwise a fast
        // load can finish before anyone is listening for it.
        const handshake = this.waitForPageReady(tab.id);
        const loaded = this.waitOnTabLoad(tab.id);

        await browser.tabs.update(tab.id, { url: this.add_job_url });
        await loaded;

        ready = await handshake;
      }

      if (!ready) {
        await this.reportNotReady(tab.id);
        return;
      }

      try {
        await browser.tabs.sendMessage(tab.id, {
          type: "FILL_OUT_JOB",
          payload: work_order,
        });
      } catch {
        this.reportError(
          "The Buildertrend page stopped responding. Please reload it and try again.",
        );
      }
    },

    // Asks the content script outright, so a tab already parked on the add-job
    // page gets checked instead of being filled blind.
    confirmPageReady: async function (tabId, timeout = 50000) {
      try {
        const response = await this.withTimeout(
          browser.tabs.sendMessage(tabId, { type: "ADD_JOB_PAGE_STATUS" }),
          timeout,
        );

        return response?.state === "ready";
      } catch {
        return false;
      }
    },

    // "Not ready" is not the same as "signed out". Buildertrend redirects signed
    // out users off the job page entirely, and the content script only runs on
    // that page - so the redirect is the reliable signal, not a missing
    // handshake.
    reportNotReady: async function (tabId) {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      const url = tab?.url || "";

      if (url && !url.includes(this.add_job_path)) {
        this.reportError(
          "Buildertrend redirected away from the new job page. Please check that you're logged in, then try again.",
        );
        return;
      }

      if (this.reported_tabs.has(tabId)) return;

      this.reportError(
        "The Buildertrend job page did not finish loading. Please reload it and try again.",
      );
    },

    // Only the tab being driven counts: another Buildertrend tab announcing
    // itself must not be mistaken for this one, or for its failure.
    waitForPageReady: function (tabId, timeout = 50000) {
      return new Promise((resolve) => {
        const settle = (ready) => {
          browser.runtime.onMessage.removeListener(listener);
          clearTimeout(timer);
          resolve(ready);
        };

        const listener = (msg, sndr) => {
          if (msg.type === "ADD_JOB_PAGE_READY" && sndr.tab?.id === tabId)
            settle(true);
        };

        browser.runtime.onMessage.addListener(listener);
        const timer = setTimeout(() => settle(false), timeout);
      });
    },

    waitOnTabLoad: function (tabId, timeout = 50000) {
      return new Promise((resolve) => {
        const settle = () => {
          browser.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        };

        const listener = (updatedTabId, info) => {
          if (updatedTabId === tabId && info.status === "complete") settle();
        };

        browser.tabs.onUpdated.addListener(listener);
        const timer = setTimeout(settle, timeout);
      });
    },

    withTimeout: function (promise, timeout) {
      let timer = null;

      return Promise.race([
        Promise.resolve(promise).finally(() => clearTimeout(timer)),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out.")), timeout);
        }),
      ]);
    },

    // The popup may already be closed; a lost report must not break the run.
    reportError: function (string) {
      try {
        const sending = browser.runtime.sendMessage({
          type: "CRITICAL_ERROR",
          payload: string,
        });

        if (sending && typeof sending.catch === "function")
          sending.catch(() => {});
      } catch {
        // no receiver
      }
    },

    removeWorkOrder: async function (work_order) {
      if (!work_order || typeof work_order !== "object")
        throw new Error("Invalid work order.");

      browser.storage.local.get("work_orders", (result) => {
        const data = result.work_orders || {};
        if (typeof data !== "object") throw new Error("Invalid map data.");

        this.work_orders = new Map(Object.entries(data));

        if (!this.work_orders.has(work_order.number || "")) return;

        this.work_orders.delete(work_order.number);

        browser.storage.local.set(
          { work_orders: Object.fromEntries(this.work_orders) },
          () => {}
        );
      });
    },
  };

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "FILL_JOB_REQUEST") {
      background.fillJob(msg, sender).catch((error) => {
        background.reportError(
          `Unable to start the job: ${error?.message || "Unexpected error."}`,
        );
      });
    }

    if (msg.type === "FILL_JOB_COMPLETE") {
      const workOrder = msg.payload || {};
      background.removeWorkOrder(workOrder);
    }

    if (msg.type === "CRITICAL_ERROR" && sender.tab?.id) {
      background.reported_tabs.add(sender.tab.id);
    }
  });
})();
