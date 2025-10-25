(() => {
  if (typeof browser === "undefined") globalThis.browser = chrome;

  const content = {
    auth_local_storage_key: "bt-object-previousAuthStoreInfo",
    pending_simulation: 0,
    fill_out_observers: new Map(),

    init: async function () {
      this.allowClicks(false);

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

      this.allowClicks(true);
    },

    startSimulation: function () {
      this.pending_simulation++;
    },

    endSimulation: function () {
      this.pending_simulation--;
    },

    fillOut: async function (work_order) {
      if (typeof work_order !== "object") throw new Error("Invalid work order");

      for (const cleanup of this.fill_out_observers.values()) cleanup();
      this.fill_out_observers.clear();

      this.allowClicks(false);

      const workOrderNumber = work_order.number || "";
      const workOrderDescription = work_order.description || "";
      const workOrderStreet = work_order.street || "";
      const workOrderCity = work_order.city || "";
      const workOrderState = work_order.state || "";
      const workOrderZip = work_order.zip || "";

      const jobTitle = workOrderStreet + " (" + workOrderNumber + ")";
      const jobType = "Handyman Services";
      const jobGroup = "Appfolio";

      // TODO: wait for the first rehydration mutation AND THEN fill out forms

      // query job title field
      const inputJobTitleIdSelector = "#jobInfo\\.jobName";
      const inputJobTitle = await this.queryElement(inputJobTitleIdSelector);
      if (!inputJobTitle) {
        this.sendCriticalErrorMessage("Unable to find Job Title field.");
        this.allowClicks(true);
        return false;
      }
      inputJobTitle.blur();

      const setupJobTitleObserver = async () => {
        const inputJobTitle = await this.queryElement(inputJobTitleIdSelector);
        if (!inputJobTitle) return;

        if (inputJobTitle.value !== jobTitle) {
          this.startSimulation();
          try {
            this.simulateInputTyping(inputJobTitle, jobTitle);
          } finally {
            this.endSimulation();
          }
        }

        const cleanupJobTitle = this.observeMutation(
          inputJobTitle,
          async () => {
            await setupJobTitleObserver();
          }
        );

        this.fill_out_observers.set("job_title", cleanupJobTitle);
      };
      await setupJobTitleObserver();

      // query job type field
      const inputJobTypeIdSelector = "#jobInfo\\.groupedProjectType";
      const inputJobType = await this.queryElement(inputJobTypeIdSelector);
      if (!inputJobType) {
        this.sendCriticalErrorMessage("Unable to find Job Type field.");
        this.allowClicks(true);
        return false;
      }
      inputJobType.blur();

      const setupJobTypeObserver = async () => {
        const inputJobType = await this.queryElement(inputJobTypeIdSelector);
        if (!inputJobType) return;

        const labelSpanJobType = await this.queryElement(
          ".ant-select-selector:has(" + inputJobTypeIdSelector + ")"
        );

        if (inputJobType.value !== jobType) {
          this.startSimulation();
          try {
            this.simulateInputTyping(inputJobType, jobType);

            const jobTypeOption = await this.queryElement(
              "[data-searchvalue='Handyman Services']"
            );
            if (!jobTypeOption) {
              await this.sendCriticalErrorMessage("Unale to find option.");
              return;
            }

            this.simulateClick(jobTypeOption);
          } finally {
            this.endSimulation();
          }
        }

        const cleanupJobType = this.observeMutation(
          [inputJobType, labelSpanJobType],
          async () => {
            await setupJobTypeObserver();
          }
        );

        this.fill_out_observers.set("job_type", cleanupJobType);
      };
      await setupJobTypeObserver();

      // query job group
      const inputJobGroupSelector =
        "[data-testid='jobGroup']:has(#jobInfo\\.jobGroups) .ant-select-selector";
      const inputJobGroup = await this.queryElement(inputJobGroupSelector);
      if (!inputJobGroup) {
        this.sendCriticalErrorMessage("Unable to find Job Group field.");
        this.allowClicks(true);
        return false;
      }
      inputJobGroup.blur();

      const setupJobGroupObserver = async () => {
        const inputJobGroup = await this.queryElement(inputJobGroupSelector);
        if (!inputJobGroup) return;

        const checkboxJobGroup = await this.queryElement(
          ".ant-select-tree-checkbox-checked:has([title='Appfolio'])",
          5000
        );
        console.log(checkboxJobGroup);
        if (!checkboxJobGroup) {
          this.startSimulation();
          try {
            this.simulateInputTyping(inputJobGroup, jobGroup);

            const jobGroupOption = await this.queryElement(
              "[data-testid='jobGroup-popup'] .ant-select-tree-list-holder-inner .ant-select-tree-treenode [title='Appfolio']"
            );
            if (!jobGroupOption) {
              await this.sendCriticalErrorMessage("Unable to find option.");
              return;
            }

            this.simulateClick(jobGroupOption);
          } finally {
            this.endSimulation();
          }
        }

        const labelSpanJobGroup = await this.queryElement(
          ".ant-select-show-search[data-testid='jobGroup'] .ant-select-selection-overflow"
        );

        const cleanupJobGroup = this.observeMutation(
          [inputJobGroup, checkboxJobGroup, labelSpanJobGroup],
          async () => {
            await setupJobGroupObserver();
          }
        );

        this.fill_out_observers.set("job_group", cleanupJobGroup);
      };
      await setupJobGroupObserver();

      // wait for pending simulations
      while (this.pending_simulation > 0) {
        await new Promise((r) => setTimeout(r, 50));
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

      this.simulateClick(input);
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
        input.value += char;
        input.dispatchEvent(inputEvent);
        input.dispatchEvent(keyupEvent);
      }
      this.simulateClick(document.body);
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

    observeMutation: function (elements, callback) {
      if (elements instanceof Element) elements = [elements];
      else if (
        !(Array.isArray(elements) || NodeList.prototype.isPrototypeOf(elements))
      )
        throw new Error(
          "Invalid element(s). Must be Element or array/NodeList of Elements."
        );

      if (typeof callback !== "function") throw new Error("Invalid callback.");

      const disconnectors = [];

      for (const element of elements) {
        const isFormField = element != null && "value" in element;

        // Create a snapshot of what we care about
        const getSnapshot = () => {
          const attrString = element
            ? Array.from(element.attributes)
                .map((a) => `${a.name}=${a.value}`)
                .join("|")
            : "";
          const content = isFormField
            ? element?.value || ""
            : element?.textContent || "";
          return attrString + "||" + content;
        };

        let lastSnapshot = getSnapshot();
        let userHasEdited = false;

        const markUserEdit = (e) => {
          if (e.isTrusted || !e.synthetic) userHasEdited = true;
        };

        const editEvents = [
          "input",
          "change",
          "keydown",
          "keyup",
          "mousedown",
          "mouseup",
          "focus",
          "click",
          "blur",
        ];
        for (const type of editEvents)
          if (element) element.addEventListener(type, markUserEdit);

        const observer = new MutationObserver(async () => {
          const snapshot = getSnapshot();
          if (snapshot === lastSnapshot) return; // ignore redundant calls

          lastSnapshot = snapshot;
          await callback(element);
        });

        if (element)
          observer.observe(element, {
            attributes: true,
            childList: true,
            characterData: true,
            subtree: true,
          });

        disconnectors.push(() => {
          observer.disconnect();
          for (const type of editEvents)
            if (element) element.removeEventListener(type, markUserEdit);
        });
      }

      return () => disconnectors.forEach((fn) => fn());
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

  window.addEventListener("load", () => {
    content.init();
  });
})();
