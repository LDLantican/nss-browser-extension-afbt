(() => {
  if (typeof browser === "undefined") globalThis.browser = chrome;

  const content = {
    auth_local_storage_key: "bt-object-previousAuthStoreInfo",
    current_fill_request: null,

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

    fillOut: async function (work_order) {
      if (typeof work_order !== "object") throw new Error("Invalid work order");

      const workOrderNumber = work_order.number || "";
      const workOrderDescription = work_order.description || "";
      const workOrderStreet = work_order.street || "";
      const workOrderCity = work_order.city || "";
      const workOrderState = work_order.state || "";
      const workOrderZip = work_order.zip || "";
      // const workOrderZip = "1234"; // FOR TESTING
      // const workOrderZip = ""; // FOR TESTING

      const jobTitle = "(" + workOrderNumber + ") " + workOrderStreet;
      // const jobTitle = "2737 a test"; // FOR TESTING
      const jobType = "Handyman Services";
      const jobGroup = "Appfolio";
      const jobClient = "Camelot Properties";

      this.allowClicks(false);

      const quickBookWidget = await this.queryElement(
        "[data-testid='accountingLinkingCard'] img.quickbooks-logo"
      );

      if (!quickBookWidget) {
        this.sendCriticalErrorMessage("Unable to find accounting link.");
        this.allowClicks(true);
        return false;
      }

      const inputJobTitleIdSelector = "#jobInfo\\.jobName";
      const inputJobTitle = await this.queryElement(inputJobTitleIdSelector);
      if (!inputJobTitle) {
        this.sendCriticalErrorMessage("Unable to find Job Title field.");
        this.allowClicks(true);
        return false;
      }

      const inputJobTypeIdSelector =
        ".ant-select-selector:has(#jobInfo\\.groupedProjectType)";
      const inputJobType = await this.queryElement(inputJobTypeIdSelector);
      if (!inputJobType) {
        this.sendCriticalErrorMessage("Unable to find Job Type field.");
        this.allowClicks(true);
        return false;
      }

      const inputJobGroupSelector =
        "[data-testid='jobGroup']:has(#jobInfo\\.jobGroups) .ant-select-selector";
      const inputJobGroup = await this.queryElement(inputJobGroupSelector);
      if (!inputJobGroup) {
        this.sendCriticalErrorMessage("Unable to find Job Group field.");
        this.allowClicks(true);
        return false;
      }

      const inputJobStreetSelector = "#jobInfo\\.address\\.street";
      const inputJobStreet = await this.queryElement(inputJobStreetSelector);
      if (!inputJobStreet) {
        this.sendCriticalErrorMessage("Unable to find Street field.");
        this.allowClicks(true);
        return false;
      }

      const inputJobCitySelector = "#jobInfo\\.address\\.city";
      const inputJobCity = await this.queryElement(inputJobCitySelector);
      if (!inputJobCity) {
        this.sendCriticalErrorMessage("Unable to find City field.");
        this.allowClicks(true);
        return false;
      }

      const inputJobStateSelector = "#jobInfo\\.address\\.state";
      const inputJobState = await this.queryElement(inputJobStateSelector);
      if (!inputJobState) {
        this.sendCriticalErrorMessage("Unable to find State field.");
        this.allowClicks(true);
        return false;
      }

      const inputJobZipSelector = "#jobInfo\\.address\\.zip";
      const inputJobZip = await this.queryElement(inputJobZipSelector);
      if (!inputJobZip) {
        this.sendCriticalErrorMessage("Unable to find Zip field.");
        this.allowClicks(true);
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
        "[data-searchvalue='Handyman Services']"
      );
      this.simulateClick(jobTypeOption);

      // job group

      let appfolioTagged = false;
      const groupSelected = document.querySelectorAll(
        "[data-testid='jobGroup'] .ant-select-selection-overflow-item"
      );
      for (const group of groupSelected) {
        if (group.textContent === jobGroup) appfolioTagged = true;
        break;
      }

      if (!appfolioTagged) {
        this.simulateClick(inputJobGroup);
        const jobGroupOption = await this.queryElement(
          `[data-testid='jobGroup-popup'] .ant-select-tree-list-holder-inner .ant-select-tree-treenode [title='${jobGroup}']`
        );
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

      // FOR TEST PURPOSE ONLY
      // const buttonCancelLink = await this.queryElement(
      //   "button[data-testid='cancelLinking']"
      // );
      // this.simulateClick(buttonCancelLink);

      // next page

      // client page
      const clientPageButton = await this.queryElement(
        "button[data-testid='clientsTab']"
      );
      if (!clientPageButton) {
        this.sendCriticalErrorMessage("Unable to find client tab.");
        this.allowClicks(true);
        return false;
      }
      this.simulateClick(clientPageButton);

      // add existing client
      const existingContactAnchor = await this.queryElement(
        "[data-testid='searchContactInfoEmptyState']"
      );
      if (!existingContactAnchor) {
        this.sendCriticalErrorMessage("Unable to add existing client.");
        this.allowClicks(true);
        return false;
      }
      this.simulateClick(existingContactAnchor);

      // search client name
      const inputNameSearchSelector = "[data-testid='nameSearch']";
      const inputNameSearch = await this.queryElement(inputNameSearchSelector);
      const buttonNameSearch = await this.queryElement(
        inputNameSearchSelector +
          " + span.ant-input-group-addon button.ant-input-search-button"
      );
      if (!inputNameSearch || !buttonNameSearch) {
        this.sendCriticalErrorMessage("Unable to search existing client.");
        this.allowClicks(true);
        return false;
      }
      this.simulateClick(inputNameSearch);
      this.simulateInputBackspace(inputNameSearch, inputNameSearch.value);
      this.simulateInputTyping(inputNameSearch, jobClient);
      this.simulateClick(buttonNameSearch);

      // select client
      const buttonJobClient = await this.queryElement(
        ".ContactSearch-Table tr[data-row-key='39778241'] button[data-testid='select']"
      );
      if (!buttonJobClient) {
        this.sendCriticalErrorMessage("Unable to select existing client.");
        this.allowClicks(true);
        return false;
      }
      this.simulateClick(buttonJobClient);

      const saveButton = await this.queryElement(
        "button#save[data-testid='save']"
      );
      if (!saveButton) {
        this.sendCriticalErrorMessage("Unable to save job.");
        this.allowClicks(true);
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.simulateClick(saveButton);

      // check for success

      const success = await this.queryElement(".ant-message-success");
      if (success) {
        await browser.runtime.sendMessage({
          type: "FILL_JOB_COMPLETE",
          payload: work_order,
        });

        this.sendFlashMessage(
          "alert",
          `${workOrderNumber} successfully added.`
        );
      } else {
        // check for errors
        const errors = await this.queryElement(
          "[data-testid='requiredCorrections']"
        );
        if (errors) {
          this.sendCriticalErrorMessage("Unable to save job.");
          this.allowClicks(true);
          return false;
        }
      }

      this.current_fill_request = null;
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

    simulateBlur: function (input) {
      if (!(input instanceof Element)) throw new Error("Invalid input.");

      const blurEvent = new FocusEvent("blur", { bubbles: false });
      blurEvent.synthetic = true;
      input.dispatchEvent(blurEvent);
    },

    sendCriticalErrorMessage: async function (string) {
      if (typeof string !== "string") throw new Error("Invalid string.");

      browser.runtime.sendMessage({
        type: "CRITICAL_ERROR",
        payload: string,
      });
    },

    sendFlashMessage: async function (type, string) {
      if (typeof type !== "string") throw new Error("Invalid flash type.");
      if (typeof string !== "string") throw new Error("Invalid string.");

      switch (type) {
        case "alert":
          browser.runtime.sendMessage({
            type: "FLASH_ALERT",
            payload: string,
          });
          break;

        case "error":
          browser.runtime.sendMessage({
            type: "FLASH_ERROR",
            payload: string,
          });
          break;
      }
    },
  };

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "FILL_OUT_JOB") {
      if (content.current_fill_request) {
        content.sendCriticalErrorMessage(
          "There is an existing process request. Please wait until it's done."
        );
        return;
      }
      const workOrder = message.payload || {};
      if (!workOrder || !workOrder?.number) return;

      content.current_fill_request = workOrder;
      content.fillOut(workOrder);
    }
  });

  window.addEventListener("load", () => {
    content.init();
  });
})();
