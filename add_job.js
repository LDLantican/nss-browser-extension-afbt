(() => {
  if (typeof browser === "undefined") globalThis.browser = chrome;

  const content = {
    auth_local_storage_key: "bt-object-previousAuthStoreInfo",

    init: async function () {
      let error = false;

      const rawAuthData = localStorage.getItem(this.auth_local_storage_key);
      if (!rawAuthData) {
        error = true;
      } else {
        const authData = JSON.parse(rawAuthData);
        if (!authData.username) error = true;
      }

      if (!error) {
        const antTypographies = await this.queryAllElements(".ant-typography");
        antTypographies.forEach((typography) => {
          const message = typography.textContent || "";
          if (
            message !==
            "Sorry, something went wrong and our systems are currently unavailable. Thank you for your patience as we work to restore access as quickly as possible."
          )
            return;

          error = true;
        });
      }

      if (!error) {
        const btMainNavigation = await this.queryElement(
          "[data-testid='bt-main-navigation']"
        );
        if (!btMainNavigation) error = true;
      }

      if (error) {
        this.sendCriticalErrorMessage(
          "Something went wrong. Please check if you're logged in Buildertrend."
        );
      } else {
        browser.runtime.sendMessage({ type: "ADD_JOB_PAGE_READY" });
      }
    },

    fillOut: async function (work_order) {
      if (typeof work_order !== "object") throw new Error("Invalid work order");

      this.allowClicks(false);

      const workOrderNumber = work_order.number || "";
      const workOrderDescription = work_order.description || "";
      const workOrderStreet = work_order.street || "";
      const workOrderCity = work_order.city || "";
      const workOrderState = work_order.state || "";
      const workOrderZip = work_order.zip || "";

      const jobTitle = workOrderStreet + " (" + workOrderNumber + ")";
      const jobType = "Handyman Services";

      // query fields
      const antCardBody = await this.queryElement(
        ".ant-card-body:has(.ant-row.BTRow-xs.BTRow-sm)"
      );

      // TODO: fix bug input field resseting
      const inputJobTitle = antCardBody.querySelector("#jobInfo\\.jobName");
      if (!inputJobTitle) {
        this.sendCriticalErrorMessage("Unable to find Job Title field.");
        return;
      } else {
        this.simulateInputTyping(inputJobTitle, jobTitle);
      }

      const inputJobType = antCardBody.querySelector(
        "#jobInfo\\.groupedProjectType"
      );
      if (!inputJobType) {
        this.sendCriticalErrorMessage("Unable to find Job Type field.");
        return;
      } else {
        this.simulateInputTyping(inputJobType, jobType);
        inputJobType.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true })
        );
      }

      this.allowClicks(true);
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

    queryAllElements: function (selector, timeout = 10000) {
      if (typeof selector !== "string") throw new Error("Invalid selector.");

      let elements = document.querySelectorAll(selector);
      if (elements.length > 0) return Promise.resolve(elements);

      return new Promise((resolve) => {
        const observer = new MutationObserver((mutationsList, obs) => {
          elements = document.querySelectorAll(selector);

          if (elements.length > 0) {
            obs.disconnect();
            clearTimeout(timer);
            resolve(elements);
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        const timer = setTimeout(() => {
          observer.disconnect();
          resolve([]);
        }, timeout);
      });
    },

    allowClicks: function (bool) {
      if (typeof bool !== "boolean") throw new Error("Invalid boolean.");

      document.body.setAttribute("data-nss-processing", !bool);
    },

    simulateInputTyping: function (input, string) {
      if (!input instanceof Element) throw new Error("Invalid input.");
      if (typeof string !== "string") throw new Error("Invalid string.");

      input.focus();

      for (const char of string) {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: char, bubbles: true })
        );
        input.value += char;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent("keyup", { key: char, bubbles: true })
        );
      }

      input.blur();
    },

    sendCriticalErrorMessage: async function (string) {
      if (typeof string !== "string") throw new Error("Invalid string.");

      browser.runtime.sendMessage({
        type: "CRITICAL_ERROR",
        payload: string,
      });
    },
  };

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "FILL_OUT_JOB") return;

    content.fillOut(message.payload || {});
  });

  content.init();
})();
