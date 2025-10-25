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
        this.observeValueReset(inputJobTitle, () => {
          this.simulateInputTyping(inputJobTitle, jobTitle);
        });
      }

      const inputJobType = antCardBody.querySelector(
        "#jobInfo\\.groupedProjectType"
      );
      if (!inputJobType) {
        this.sendCriticalErrorMessage("Unable to find Job Type field.");
        return;
      } else {
        this.simulateInputTyping(inputJobType, jobType);
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
      if (!(input instanceof Element)) throw new Error("Invalid input.");
      if (typeof string !== "string") throw new Error("Invalid string.");

      // input.focus();

      // for (const char of string) {
      //   input.dispatchEvent(
      //     new KeyboardEvent("keydown", { key: char, bubbles: true })
      //   );
      //   input.value += char;
      //   input.dispatchEvent(new Event("input", { bubbles: true }));
      //   input.dispatchEvent(
      //     new KeyboardEvent("keyup", { key: char, bubbles: true })
      //   );
      // }

      // input.blur();

      // const descriptor = Object.getOwnPropertyDescriptor(
      //   Object.getPrototypeOf(input),
      //   "value"
      // );
      // setter.call(input, string);

      // input.dispatchEvent(new Event("input", { bubbles: true }));
      // input.dispatchEvent(new Event("change", { bubbles: true }));

      // determine which prototype defines the native "value" property
      let proto = Object.getPrototypeOf(input);
      if (!proto || !Object.getOwnPropertyDescriptor(proto, "value")) {
        // fallback for <textarea> and <select>
        if (input instanceof HTMLTextAreaElement) {
          proto = HTMLTextAreaElement.prototype;
        } else if (input instanceof HTMLSelectElement) {
          proto = HTMLSelectElement.prototype;
        } else {
          proto = HTMLInputElement.prototype;
        }
      }

      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");

      // safely set the value
      if (descriptor && typeof descriptor.set === "function") {
        descriptor.set.call(input, string);
      } else {
        // fallback for elements without a standard value setter
        input.value = string;
      }

      // dispatch the appropriate events so frameworks like React, Vue, Angular, etc. update
      const inputEvent = new Event("input", {
        bubbles: true,
        cancelable: true,
      });
      const changeEvent = new Event("change", {
        bubbles: true,
        cancelable: true,
      });

      inputEvent.synthetic = true;
      changeEvent.synthetic = true;

      input.dispatchEvent(inputEvent);
      input.dispatchEvent(changeEvent);

      // optional - handle <select> specifically (React often uses 'change' only)
      if (input instanceof HTMLSelectElement) {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },

    observeValueReset: function (input, callback) {
      if (!(input instanceof Element)) throw new Error("Invalid input.");
      if (typeof callback !== "function") throw new Error("Invalid callback.");

      let lastValue = input.value;
      let userHasEdited = false;

      const markUserEdit = (e) => {
        if (e.isTrusted || !e.synthetic) userHasEdited = true;
      };

      input.addEventListener("input", markUserEdit);
      input.addEventListener("keydown", markUserEdit);
      input.addEventListener("mousedown", markUserEdit);
      input.addEventListener("focus", markUserEdit);

      const observer = new MutationObserver(() => {
        if (input.value === lastValue) return;

        lastValue = input.value;
        if (input.value === "" && !userHasEdited) callback();
      });

      observer.observe(input, { attributes: true, attributeFilter: ["value"] });

      const interval = setInterval(() => {
        if (input.value === lastValue) return;

        lastValue = input.value;
        if (input.value === "" && !userHasEdited) callback();
      }, 500);

      return () => {
        observer.disconnect();
        clearInterval(interval);
        input.removeEventListener("input", markUserEdit);
        input.removeEventListener("keydown", markUserEdit);
        input.removeEventListener("mousedown", markUserEdit);
        input.removeEventListener("focus", markUserEdit);
      };
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
