// Prevent double-injection
if (!window.__CODE_EXPLAINER_INJECTED__) {
  window.__CODE_EXPLAINER_INJECTED__ = true;

  // Add message listener for background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("Content script received message:", request);

    switch (request.action) {
      case "ping":
        // Respond to ping to confirm content script is active
        console.log("Content script responding to ping");
        sendResponse({ status: "pong", timestamp: Date.now() });
        return true; // Keep message channel open

      case "explainSelectedText":
        if (window.__CODE_EXPLAINER_INSTANCE__) {
          window.__CODE_EXPLAINER_INSTANCE__.selectedText = request.text;
          window.__CODE_EXPLAINER_INSTANCE__.explainSelectedCode();
        }
        sendResponse({ success: true });
        return true;

      case "showCodeSelection":
        if (window.__CODE_EXPLAINER_INSTANCE__) {
          window.__CODE_EXPLAINER_INSTANCE__.showMessage(
            "Select code to explain."
          );
        }
        sendResponse({ success: true });
        return true;

      case "toggleSidebar":
        if (window.__CODE_EXPLAINER_INSTANCE__) {
          window.__CODE_EXPLAINER_INSTANCE__.toggleSidebar();
        }
        sendResponse({ success: true });
        return true;

      default:
        console.warn("Unknown action:", request.action);
        sendResponse({ error: "Unknown action" });
        return true;
    }
  });

  // Signal that content script is loaded
  console.log("Code Explainer content script loaded successfully");

  // Check if runtime is available before attempting connection
  const checkRuntimeConnection = () => {
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(
          { action: "contentScriptReady" },
          (response) => {
            if (chrome.runtime.lastError) {
              console.log(
                "Background script not ready yet:",
                chrome.runtime.lastError.message
              );
            } else {
              console.log("Confirmed connection with background script");
            }
          }
        );
      }
    } catch (error) {
      console.log("Could not connect to background script:", error.message);
    }
  };

  // Try connection immediately and retry if needed
  checkRuntimeConnection();
  setTimeout(checkRuntimeConnection, 1000); // Retry after 1 second

  // Define the class first (but don't instantiate yet)
  if (!window.CodeExplainerContent) {
    window.CodeExplainerContent = class CodeExplainerContent {
      constructor() {
        this.selectedText = "";
        this.selectedElement = null;
        this.isActive = false;
        this.sidebar = null;
        this.floatingButton = null;
        this.connectionRetries = 0;
        this.maxRetries = 3;

        // Rate limiting
        this.lastRequestTime = 0;
        this.minRequestInterval = 3000; // 3 seconds between requests
        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.maxRetries = 3;
        this.retryDelay = 5000; // 5 seconds initial retry delay
      }

      async init() {
        this.setupEventListeners();
        this.createFloatingButton();

        // Test API key availability on init with retry logic
        const connected = await this.ensureConnection();
        if (connected) {
          await this.checkApiKeyStatus();
        }
      }

      async ensureConnection() {
        for (let i = 0; i < this.maxRetries; i++) {
          try {
            // Test connection with ping
            const response = await this.sendMessageToBackground(
              { action: "ping" },
              3000
            );
            if (response && response.status === "pong") {
              console.log("Background script connection confirmed");
              return true;
            }
          } catch (error) {
            console.log(`Connection attempt ${i + 1} failed:`, error.message);
            if (i < this.maxRetries - 1) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }

        this.showMessage(
          "Extension communication error. Please refresh the page and try again."
        );
        return false;
      }

      async checkApiKeyStatus() {
        try {
          // Check if API key is configured by sending message to background
          const response = await this.sendMessageToBackground(
            {
              action: "checkApiKey",
            },
            5000
          );

          if (!response.hasApiKey) {
            console.warn("API key not configured");
            this.showMessage(
              "Please configure your OpenAI API key in the extension popup"
            );
            return false;
          }

          console.log("API key is configured");
          return true;
        } catch (error) {
          console.error("Failed to check API key status:", error);
          return false;
        }
      }

      // Helper method to send messages to background script with proper error handling and rate limiting
      async sendMessageToBackground(message, timeout = 15000) {
        return new Promise((resolve, reject) => {
          // Check if extension context is valid
          if (!chrome.runtime || !chrome.runtime.id) {
            reject(
              new Error(
                "Extension context invalidated. Please refresh the page."
              )
            );
            return;
          }

          const timeoutId = setTimeout(() => {
            reject(
              new Error(
                "Request timed out. The background script may be busy or unresponsive."
              )
            );
          }, timeout);

          try {
            chrome.runtime.sendMessage(message, (response) => {
              clearTimeout(timeoutId);

              if (chrome.runtime.lastError) {
                const error = chrome.runtime.lastError.message;
                if (error.includes("Extension context invalidated")) {
                  reject(
                    new Error(
                      "Extension was reloaded. Please refresh this page."
                    )
                  );
                } else if (error.includes("Receiving end does not exist")) {
                  reject(
                    new Error(
                      "Background script is not running. Please check if the extension is enabled."
                    )
                  );
                } else {
                  reject(new Error(`Chrome runtime error: ${error}`));
                }
              } else if (response && response.error) {
                // Handle specific API errors
                if (
                  response.error.includes("rate limit") ||
                  response.error.includes("too quickly")
                ) {
                  reject(
                    new Error(
                      "You're making requests too quickly. Please wait a moment and try again. If this persists, check your OpenAI API usage limits."
                    )
                  );
                } else if (
                  response.error.includes("quota") ||
                  response.error.includes("billing")
                ) {
                  reject(
                    new Error(
                      "OpenAI API quota exceeded. Please check your billing and usage limits."
                    )
                  );
                } else if (
                  response.error.includes("invalid") &&
                  response.error.includes("key")
                ) {
                  reject(
                    new Error(
                      "Invalid API key. Please check your OpenAI API key configuration."
                    )
                  );
                } else {
                  reject(new Error(response.error));
                }
              } else if (!response) {
                reject(
                  new Error("No response received from background script")
                );
              } else {
                resolve(response);
              }
            });
          } catch (error) {
            clearTimeout(timeoutId);
            reject(new Error(`Failed to send message: ${error.message}`));
          }
        });
      }

      // Rate-limited API request wrapper
      async sendAPIRequest(message, retryCount = 0) {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        // Enforce minimum interval between requests
        if (timeSinceLastRequest < this.minRequestInterval) {
          const waitTime = this.minRequestInterval - timeSinceLastRequest;
          console.log(
            `Rate limiting: waiting ${waitTime}ms before next request`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }

        this.lastRequestTime = Date.now();

        try {
          const response = await this.sendMessageToBackground(message, 45000); // Longer timeout for API calls
          return response;
        } catch (error) {
          // Handle rate limit errors with exponential backoff
          if (
            error.message.includes("too quickly") ||
            error.message.includes("rate limit")
          ) {
            if (retryCount < this.maxRetries) {
              const delay = this.retryDelay * Math.pow(2, retryCount); // Exponential backoff
              console.log(
                `Rate limited, retrying in ${delay}ms (attempt ${
                  retryCount + 1
                }/${this.maxRetries})`
              );

              // Show user-friendly message about waiting
              this.showMessage(
                `Rate limited by OpenAI. Retrying in ${Math.ceil(
                  delay / 1000
                )} seconds... (${retryCount + 1}/${this.maxRetries})`
              );

              await new Promise((resolve) => setTimeout(resolve, delay));
              return this.sendAPIRequest(message, retryCount + 1);
            } else {
              throw new Error(
                "Rate limit exceeded. Please wait a few minutes before trying again."
              );
            }
          }
          throw error;
        }
      }

      setupEventListeners() {
        // Handle text selection
        document.addEventListener("mouseup", (e) => {
          setTimeout(() => this.handleSelection(e), 100);
        });

        // Handle keyboard shortcut (Ctrl+Shift+E)
        document.addEventListener("keydown", (e) => {
          if (e.ctrlKey && e.shiftKey && e.key === "E") {
            e.preventDefault();
            this.handleSelection(e);
          }
        });

        // Listen for messages from popup/background (redundant but kept for compatibility)
        chrome.runtime.onMessage.addListener(
          (request, sender, sendResponse) => {
            if (request.action === "explainSelected") {
              this.explainSelectedCode();
            } else if (request.action === "toggleSidebar") {
              this.toggleSidebar();
            }
          }
        );
      }

      createFloatingButton() {
        const button = document.createElement("div");
        button.id = "code-explainer-float-btn";
        button.innerHTML = "🔍 Explain Code";
        button.style.cssText = `
          position: fixed;
          top: -50px;
          left: 50%;
          transform: translateX(-50%);
          background: #4CAF50;
          color: white;
          padding: 8px 16px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: bold;
          cursor: pointer;
          z-index: 10000;
          box-shadow: 0 2px 10px rgba(0,0,0,0.3);
          transition: top 0.3s ease;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;

        button.addEventListener("click", () => {
          this.explainSelectedCode();
          this.hideFloatingButton();
        });

        document.body.appendChild(button);
        this.floatingButton = button;
      }

      showFloatingButton(x, y) {
        if (this.floatingButton) {
          this.floatingButton.style.left = `${x}px`;
          this.floatingButton.style.top = `${y - 60}px`;
        }
      }

      hideFloatingButton() {
        if (this.floatingButton) {
          this.floatingButton.style.top = "-50px";
        }
      }

      handleSelection(e) {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();

        if (selectedText.length > 10 && this.looksLikeCode(selectedText)) {
          this.selectedText = selectedText;
          this.selectedElement = selection.anchorNode.parentElement;

          // Show floating button near selection
          const rect = selection.getRangeAt(0).getBoundingClientRect();
          this.showFloatingButton(
            rect.left + rect.width / 2,
            rect.top + window.scrollY
          );
        } else {
          this.hideFloatingButton();
        }
      }

      looksLikeCode(text) {
        const codeIndicators = [
          /[{}();]/, // Common code symbols
          /function\s+\w+/, // Function definitions
          /class\s+\w+/, // Class definitions
          /import\s+/, // Import statements
          /def\s+\w+/, // Python functions
          /\w+\.\w+\(/, // Method calls
          /=>\s*{/, // Arrow functions
          /\$\w+/, // Variables (PHP, etc.)
          /console\./, // Console statements
          /print\(/, // Print statements
        ];

        // Check if it's inside a code element
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
          const element =
            selection.getRangeAt(0).commonAncestorContainer.parentElement;
          const isInCodeElement = element.closest(
            "code, pre, .highlight, .sourceCode, .code-block, .language-"
          );
          if (isInCodeElement) return true;
        }

        // Check content patterns
        return (
          codeIndicators.some((pattern) => pattern.test(text)) ||
          (text.split("\n").length > 2 && /^\s+/.test(text))
        ); // Multi-line with indentation
      }

      async explainSelectedCode() {
        if (!this.selectedText) {
          this.showMessage("No code selected. Please select some code first.");
          return;
        }

        // Check if another request is in progress
        if (this.isProcessingQueue) {
          this.showMessage(
            "Another request is already in progress. Please wait..."
          );
          return;
        }

        try {
          this.isProcessingQueue = true;
          this.showLoadingState();

          // Ensure connection before proceeding
          const connected = await this.ensureConnection();
          if (!connected) {
            throw new Error(
              "Could not establish connection with background script"
            );
          }

          // Extract context from surrounding code
          const context = this.extractContext(this.selectedElement);

          // Send request with rate limiting
          const response = await this.sendAPIRequest({
            action: "explainCode",
            code: this.selectedText,
            language: this.detectLanguage(this.selectedText),
            context: context,
            url: window.location.href,
            title: document.title,
          });

          if (response.explanation) {
            this.showExplanation(response.explanation);
            this.saveToHistory(this.selectedText, response.explanation);
          } else {
            throw new Error("No explanation received from background script");
          }
        } catch (error) {
          console.error("Error explaining code:", error);

          // Show user-friendly error message
          let errorMessage = "Error: " + error.message;
          if (error.message.includes("API key")) {
            errorMessage =
              "Please set your OpenAI API key in the extension popup first.";
          } else if (
            error.message.includes("too quickly") ||
            error.message.includes("rate limit")
          ) {
            errorMessage =
              "Making requests too quickly. Please wait a moment before trying again.";
          } else if (
            error.message.includes("quota") ||
            error.message.includes("billing")
          ) {
            errorMessage =
              "OpenAI API quota exceeded. Please check your billing and usage limits.";
          } else if (
            error.message.includes("timed out") ||
            error.message.includes("timeout")
          ) {
            errorMessage =
              "Request timed out. The API might be busy. Please try again in a moment.";
          } else if (
            error.message.includes("background script") ||
            error.message.includes("Extension context")
          ) {
            errorMessage =
              "Extension communication error. Please refresh the page and try again.";
          } else if (error.message.includes("not running")) {
            errorMessage =
              "Extension background script is not active. Please check if the extension is enabled.";
          } else if (error.message.includes("reloaded")) {
            errorMessage = "Extension was reloaded. Please refresh this page.";
          }

          this.showMessage(errorMessage);

          // Hide sidebar on error
          if (this.sidebar) {
            this.sidebar.classList.remove("visible");
          }
        } finally {
          this.isProcessingQueue = false;
        }
      }

      extractContext(element) {
        if (!element) return "";

        // Try to find surrounding code context
        const codeContainer = element.closest(
          "pre, code, .highlight, .sourceCode, .code-block"
        );
        if (codeContainer && codeContainer.textContent) {
          return codeContainer.textContent.substring(0, 500); // Limit context size
        }

        return "";
      }

      detectLanguage(code) {
        // Simple language detection based on patterns
        if (
          /^\s*function\s+\w+/.test(code) ||
          /^\s*const\s+\w+\s*=/.test(code)
        ) {
          return "javascript";
        } else if (
          /^\s*def\s+\w+/.test(code) ||
          /^\s*import\s+\w+/.test(code)
        ) {
          return "python";
        } else if (
          /^\s*public\s+class/.test(code) ||
          /^\s*private\s+\w+/.test(code)
        ) {
          return "java";
        } else if (/^\s*#include/.test(code) || /^\s*int\s+main/.test(code)) {
          return "c";
        }
        return "unknown";
      }

      showLoadingState() {
        if (!this.sidebar) {
          this.createSidebar();
        }

        const content = this.sidebar.querySelector(".sidebar-content");
        const timeSinceLastRequest = Date.now() - this.lastRequestTime;
        const waitTime = Math.max(
          0,
          this.minRequestInterval - timeSinceLastRequest
        );

        content.innerHTML = `
          <div class="loading-state">
            <div class="spinner"></div>
            <h3>Analyzing Code...</h3>
            <p>GPT is examining your code snippet and preparing a detailed explanation.</p>
            ${
              waitTime > 0
                ? `<p><small>Rate limiting: waiting ${Math.ceil(
                    waitTime / 1000
                  )} seconds...</small></p>`
                : ""
            }
            <small>This may take up to 45 seconds for complex code.</small>
          </div>
        `;

        this.sidebar.classList.add("visible");
      }

      showExplanation(result) {
        if (!this.sidebar) {
          this.createSidebar();
        }

        const content = this.sidebar.querySelector(".sidebar-content");
        content.innerHTML = `
          <div class="explanation-header">
            <h2>Code Explanation</h2>
            <span class="language-badge">${result.language || "Unknown"}</span>
            <button class="close-btn" onclick="this.closest('.code-explainer-sidebar').classList.remove('visible')">×</button>
          </div>
          
          <div class="code-snippet">
            <h4>Selected Code:</h4>
            <pre><code>${this.escapeHtml(this.selectedText)}</code></pre>
          </div>
          
          <div class="explanation-content">
            ${this.formatExplanation(result.explanation || result)}
          </div>
          
          <div class="follow-up-section">
            <h4>Ask a follow-up question:</h4>
            <div class="follow-up-input">
              <input type="text" placeholder="e.g., 'What's the time complexity?' or 'How can this be improved?'" />
              <button onclick="this.handleFollowUp()">Ask</button>
            </div>
          </div>
          
          <div class="action-buttons">
            <button onclick="this.saveToFavorites()">⭐ Save to Favorites</button>
            <button onclick="this.copyExplanation()">📋 Copy Explanation</button>
          </div>
        `;

        this.sidebar.classList.add("visible");
        this.setupFollowUpHandler(result);
      }

      formatExplanation(explanation) {
        // Handle both string and object explanations
        const text =
          typeof explanation === "string"
            ? explanation
            : explanation.explanation || "";

        // Convert markdown-like formatting to HTML
        return text
          .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
          .replace(/\*(.*?)\*/g, "<em>$1</em>")
          .replace(/`(.*?)`/g, "<code>$1</code>")
          .replace(/\n\n/g, "</p><p>")
          .replace(/\n/g, "<br>")
          .replace(/^(.*)$/, "<p>$1</p>");
      }

      createSidebar() {
        const sidebar = document.createElement("div");
        sidebar.className = "code-explainer-sidebar";
        sidebar.innerHTML = `
          <div class="sidebar-content"></div>
          <div class="sidebar-resize-handle"></div>
        `;

        document.body.appendChild(sidebar);
        this.sidebar = sidebar;
        this.setupSidebarResize();
      }

      setupSidebarResize() {
        const handle = this.sidebar.querySelector(".sidebar-resize-handle");
        let isResizing = false;

        handle.addEventListener("mousedown", (e) => {
          isResizing = true;
          e.preventDefault();
        });

        document.addEventListener("mousemove", (e) => {
          if (isResizing) {
            const newWidth = window.innerWidth - e.clientX;
            this.sidebar.style.width =
              Math.max(300, Math.min(800, newWidth)) + "px";
          }
        });

        document.addEventListener("mouseup", () => {
          isResizing = false;
        });
      }

      setupFollowUpHandler(originalResult) {
        const input = this.sidebar.querySelector(".follow-up-input input");
        const button = this.sidebar.querySelector(".follow-up-input button");

        const handleFollowUp = async () => {
          const question = input.value.trim();
          if (!question) return;

          try {
            button.disabled = true;
            button.textContent = "Thinking...";

            const response = await this.sendAPIRequest({
              action: "askFollowUp",
              question: question,
              originalCode: this.selectedText,
              originalExplanation: originalResult.explanation || originalResult,
            });

            // Add follow-up to the explanation
            const followUpDiv = document.createElement("div");
            followUpDiv.className = "follow-up-answer";
            followUpDiv.innerHTML = `
              <h5>Q: ${this.escapeHtml(question)}</h5>
              <div class="answer">${this.formatExplanation(
                response.answer
              )}</div>
            `;

            this.sidebar
              .querySelector(".explanation-content")
              .appendChild(followUpDiv);
            input.value = "";
          } catch (error) {
            this.showMessage(
              "Error answering follow-up question: " + error.message
            );
          } finally {
            button.disabled = false;
            button.textContent = "Ask";
          }
        };

        button.onclick = handleFollowUp;
        input.addEventListener("keypress", (e) => {
          if (e.key === "Enter") handleFollowUp();
        });
      }

      async saveToHistory(code, result) {
        try {
          await this.sendMessageToBackground(
            {
              action: "saveExplanation",
              explanation: {
                id: Date.now(),
                code: code,
                explanation: result.explanation || result,
                language: result.language || "unknown",
                timestamp: Date.now(),
                url: window.location.href,
                title: document.title,
              },
            },
            5000
          );
        } catch (error) {
          console.error("Failed to save to history:", error);
          // Don't show error to user for this non-critical operation
        }
      }

      toggleSidebar() {
        if (this.sidebar) {
          this.sidebar.classList.toggle("visible");
        }
      }

      showMessage(message) {
        // Create temporary message overlay
        const overlay = document.createElement("div");
        overlay.style.cssText = `
          position: fixed;
          top: 20px;
          right: 20px;
          background: #333;
          color: white;
          padding: 12px 20px;
          border-radius: 8px;
          z-index: 10001;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
          max-width: 300px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          line-height: 1.4;
        `;
        overlay.textContent = message;

        document.body.appendChild(overlay);
        setTimeout(() => overlay.remove(), 5000);
      }

      escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
      }
    };
  }

  // Instantiate with delay to ensure DOM is ready
  const initializeExtension = () => {
    if (!window.__CODE_EXPLAINER_INSTANCE__) {
      window.__CODE_EXPLAINER_INSTANCE__ = new window.CodeExplainerContent();
      window.__CODE_EXPLAINER_INSTANCE__.init();
    }
  };

  // Initialize immediately if DOM is ready, otherwise wait
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeExtension);
  } else {
    initializeExtension();
  }
}
