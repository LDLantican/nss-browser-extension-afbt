(() => {
  if (typeof browser === "undefined") globalThis.browser = chrome;

  const background = {
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

      const readyTabId = await handshakePromise;
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
  };

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "FILL_JOB_REQUEST") {
      background.fillJob(msg, sender);
    }
  });
})();
