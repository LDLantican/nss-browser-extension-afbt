document.addEventListener("DOMContentLoaded", () => {
  if (browser === undefined) var browser = chrome;

  const plugin = {
    websites: ["buildertrend.net", "appfolio.com"],

    start: async function () {
      // wip

      // check if on Appfolio or Buildertrend
      const currentTab = await this.getActiveTabURL();
      if (!this.websites.some((domain) => currentTab.url.includes(domain))) {
        this.criticalError(
          "You must be on Appfolio or Buildertrend to use this plugin."
        );
        this.load(false);
        return;
      }

      // propagate work orders from the storage

      // if work orders are not empty, show clear all button

      this.load(false);
    },

    load: function (bool) {
      setTimeout(() => {
        document.body.setAttribute("data-loading", bool);
      }, 0);
    },

    terminate: function () {
      document.body.setAttribute("data-running", false);
    },

    alert(msg, option = { timeout: 10000 }) {
      if (typeof msg !== "string") throw new Error("Invalid string.");
      if (option.timeout !== undefined && typeof option.timeout !== "number")
        throw new Error("Invalid timeout.");

      const flash = this.queryElement("#flash");
      if (!flash) throw new Error("Flash is missing.");

      const li = document.createElement("li");
      const p = document.createElement("p");
      p.className = "alert";
      p.textContent = "\u26A0 " + msg;

      li.appendChild(p);
      flash.appendChild(li);

      li.addEventListener("click", () => {
        flash.removeChild(li);
      });

      setTimeout(() => {
        flash.removeChild(li);
      }, option.timeout);
    },

    error(msg, option = { persist: false, timeout: 10000 }) {
      if (typeof msg !== "string") throw new Error("Invalid string.");
      if (option.timeout !== undefined && typeof option.timeout !== "number")
        throw new Error("Invalid timeout.");

      const flash = this.queryElement("#flash");
      if (!flash) throw new Error("Flash is missing.");

      const li = document.createElement("li");
      const p = document.createElement("p");
      p.setAttribute("data-critical", option.persist);
      p.className = "error";
      p.textContent = "\u26A0 " + msg;

      li.appendChild(p);
      flash.appendChild(li);

      if (!option.persist) {
        li.addEventListener("click", () => {
          flash.removeChild(li);
        });

        setTimeout(() => {
          flash.removeChild(li);
        }, option.timeout);
      }
    },

    criticalError: function (msg) {
      if (typeof msg !== "string") throw new Error("Invalid string.");

      this.error(msg, { persist: true });
      this.terminate();
    },

    queryElement: function (selector, timeout = 10000) {
      if (typeof selector !== "string") throw new Error("Invalid selector.");
      if (timeout !== undefined && typeof timeout !== "number")
        throw new Error("Invalid timeout.");

      let element = document.querySelector(selector);
      if (element) return element;

      const startTime = Date.now();

      while (!element && Date.now() - startTime < timeout) {
        element = document.querySelector(selector);
      }

      return element;
    },

    getActiveTabURL: async function () {
      const [tab] = await browser.tabs.query({
        currentWindow: true,
        active: true,
      });

      return tab;
    },

    listen: function (msg, sender, senderResponse) {
      // wip
    },
  };

  window.addEventListener("load", () => {
    plugin.start();
  });

  browser.runtime.onMessage.addListener((msg, sender, senderResponse) => {
    plugin.listen(msg, sender, senderResponse);
    return true;
  });
});
