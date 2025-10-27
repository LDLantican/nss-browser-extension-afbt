(() => {
  if (typeof browser === "undefined") globalThis.browser = chrome;

  const background = {
    work_orders: new Map(),

    fillJob: async function (message, sender) {
      const work_order = message.payload || null;
      if (typeof work_order !== "object")
        throw new Error("Invalid work order.");

      const addNewJobUrl =
        "https://buildertrend.net/app/JobPage/0/1?openCondensed=true";

      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });

      let readyTabId = tab.id;
      const isOnTargetPage = tab.url?.startsWith(addNewJobUrl);

      if (!isOnTargetPage) {
        const handshakePromise = new Promise((resolve) => {
          const listener = (msg, sndr) => {
            if (msg.type === "ADD_JOB_PAGE_READY") {
              browser.runtime.onMessage.removeListener(listener);
              resolve(sndr.tab?.id);
            }
          };
          browser.runtime.onMessage.addListener(listener);
        });

        await browser.tabs.update(tab.id, { url: addNewJobUrl });
        await this.waitOnTabLoad(tab.id);

        readyTabId = await handshakePromise;
      }

      browser.tabs.sendMessage(readyTabId, {
        type: "FILL_OUT_JOB",
        payload: work_order,
      });
    },

    waitOnTabLoad: function (tabId) {
      return new Promise((resolve) => {
        const listener = (updatedTabId, info) => {
          if (updatedTabId === tabId && info.status === "complete") {
            browser.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        browser.tabs.onUpdated.addListener(listener);
      });
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
      background.fillJob(msg, sender);
    }

    if (msg.type === "FILL_JOB_COMPLETE") {
      const workOrder = msg.payload || {};
      background.removeWorkOrder(workOrder);
    }
  });
})();
