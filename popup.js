document.addEventListener("DOMContentLoaded", () => {
  const plugin = {
    isActive: false,
    isLoggedIn: false,
    currentTab: null,

    mainContent: null,
    alertSpan: null,

    errors: [],

    init: async function () {
      const alertSpan = document.querySelector("span#alert");
      if (!alertSpan) return;
      this.alertSpan = alertSpan;

      const mainContent = document.querySelector("main");
      if (!mainContent) return;
      this.mainContent = mainContent;

      this.currentTab = await this.getActiveTabURL();
      if (!this.isOnBuilderTrend()) {
        this.criticalError("Go to BuilderTrend to start importing.");
        return;
      }

      this.isLoggedIn = await this.isLoggedInBuilderTrend();
      if (!this.isLoggedIn) {
        this.criticalError("Please login to BuilderTrend.");
        return;
      }

      this.isActive = true;
    },

    criticalError: function (msg) {
      this.isActive = false;
      this.alertSpan.textContent = msg;
      this.mainContent.setAttribute("data-shown", "false");
    },

    queryElement: function (selector, timeout = 10000) {
      // WIP
    },

    getActiveTabURL: async function () {
      const tabs = await chrome.tabs.query({
        currentWindow: true,
        active: true,
      });

      return tabs[0];
    },

    listen: function (msg, sender, senderResponse) {
      if (msg.type === "BT_AUTH_CHANGED") {
        const auth = msg.data ? JSON.parse(msg.data) : null;

        if (auth?.username) {
          this.isLoggedIn = true;
        } else {
          this.isLoggedIn = false;
        }
      }

      if (!this.isOnBuilderTrend()) {
        this.criticalError("Go to BuilderTrend to start importing.");
        return;
      }

      if (!this.isLoggedIn) {
        this.criticalError("Please login to BuilderTrend.");
        return;
      }

      if (!this.errors) {
        this.alertSpan.textContent = "";
        this.mainContent.setAttribute("data-shown", "true");
      }
    },

    isOnBuilderTrend: function () {
      const urls = ["buildertrend.net", "buildertrend.com"];
      return urls.some((domain) => this.currentTab.url.includes(domain));
    },

    isLoggedInBuilderTrend: async function () {
      try {
        const response = await new Promise((resolve) => {
          chrome.tabs.sendMessage(
            this.currentTab.id,
            { type: "GET_BT_AUTH" },
            (res) => resolve(res)
          );
        });

        if (chrome.runtime.lastError) {
          this.criticalError("No content script detected or tab not ready.");
          return false;
        }

        if (!response?.authData) return false;

        const auth = JSON.parse(response.authData);
        return Boolean(auth?.username);
      } catch (err) {
        console.error("Error checking Buildertrend auth: ", err);
        return false;
      }
    },
  };

  window.addEventListener("load", () => {
    plugin.init();

    setTimeout(() => {
      document.body.setAttribute("data-loading", "false");
    }, 0);
  });

  chrome.runtime.onMessage.addListener((msg, sender, senderResponse) => {
    plugin.listen(msg, sender, senderResponse);
  });
});
