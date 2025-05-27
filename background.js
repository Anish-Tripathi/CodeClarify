// Utility function to check if content script is present
async function checkContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "ping" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// Utility function to inject content script
async function injectContentScript(tabId) {
  try {
    // Check if tab still exists and is valid
    const tab = await chrome.tabs.get(tabId);
    if (
      !tab ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("moz-extension://") ||
      tab.url === "about:blank"
    ) {
      return false; // Can't inject into restricted pages
    }

    // Inject CSS first
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["content.css"],
      });
    } catch (cssError) {
      console.warn("CSS injection failed (non-critical):", cssError);
    }

    // Inject JavaScript
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    // Wait for script to initialize and verify it's working
    await new Promise((resolve) => setTimeout(resolve, 500)); // Increased wait time

    // Verify injection worked
    const isPresent = await checkContentScript(tabId);
    return isPresent;
  } catch (err) {
    console.warn("Failed to inject content script:", err);
    return false;
  }
}

// Enhanced utility function to ensure content script is present
async function ensureContentScript(tabId) {
  // First check if it's already present
  const isPresent = await checkContentScript(tabId);
  if (isPresent) {
    return true;
  }

  // If not present, try to inject
  return await injectContentScript(tabId);
}

// Safe message sending with better error handling
async function safeMessageSend(tabId, message, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      // Ensure content script is present
      const injected = await ensureContentScript(tabId);
      if (!injected) {
        throw new Error(
          "Cannot inject content script into this tab - restricted page or injection failed"
        );
      }

      // Send message with increased timeout
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Message timeout - content script not responding"));
        }, 10000); // Increased timeout to 10 seconds

        chrome.tabs.sendMessage(tabId, message, (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    } catch (error) {
      console.warn(`Message attempt ${i + 1} failed:`, error.message);

      if (i === retries) {
        throw error;
      }

      // Progressive backoff: 300ms, 600ms, 1200ms
      const delay = Math.min(300 * Math.pow(2, i), 1500);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// LangChain Code Explainer Service
class LangChainCodeExplainer {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.apiUrl = "https://api.openai.com/v1/chat/completions";
    this.requestQueue = [];
    this.isProcessing = false;
    this.lastRequestTime = 0;
    this.minRequestInterval = 1000; // 1 second between requests
    this.maxRetries = 3;
  }

  async explainCode(code, language, options = {}) {
    const {
      model = "gpt-3.5-turbo",
      temperature = 0.7,
      maxTokens = 1000,
      context,
    } = options;

    const prompt = this.buildExplanationPrompt(code, language, context);

    const requestData = {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful code explanation assistant. Provide clear, concise explanations of code snippets.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature,
      max_tokens: maxTokens,
    };

    try {
      const data = await this.makeRateLimitedRequest(requestData);

      return {
        explanation: data.choices[0].message.content,
        timestamp: Date.now(),
        tokens: data.usage?.total_tokens || 0,
      };
    } catch (error) {
      console.error("LangChain service error:", error);
      throw error;
    }
  }

  async askFollowUp(question, originalCode, originalExplanation) {
    const prompt = `
Original Code:
\`\`\`
${originalCode}
\`\`\`

Previous Explanation:
${originalExplanation}

Follow-up Question: ${question}

Please provide a detailed answer to the follow-up question about the code.
`;

    const requestData = {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful code explanation assistant. Answer follow-up questions about code clearly and accurately.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    };

    try {
      const data = await this.makeRateLimitedRequest(requestData);
      return {
        answer: data.choices[0].message.content,
        timestamp: Date.now(),
        tokens: data.usage?.total_tokens || 0,
      };
    } catch (error) {
      console.error("Follow-up question error:", error);
      throw error;
    }
  }

  async makeRateLimitedRequest(requestData, retryCount = 0) {
    // Wait for rate limit
    await this.waitForRateLimit();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const response = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestData),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      this.lastRequestTime = Date.now();

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        // Handle rate limiting specifically
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");
          const waitTime = retryAfter
            ? parseInt(retryAfter) * 1000
            : this.calculateBackoffDelay(retryCount);

          if (retryCount < this.maxRetries) {
            console.log(
              `Rate limited. Retrying in ${waitTime}ms (attempt ${
                retryCount + 1
              }/${this.maxRetries})`
            );
            await this.sleep(waitTime);
            return this.makeRateLimitedRequest(requestData, retryCount + 1);
          } else {
            throw new Error(
              "Rate limit exceeded. Please try again later or check your API quota."
            );
          }
        }

        // Handle other API errors
        if (response.status === 401) {
          throw new Error(
            "Invalid API key. Please check your OpenAI API key configuration."
          );
        }

        if (response.status === 403) {
          throw new Error(
            "API access forbidden. Please check your API key permissions."
          );
        }

        if (response.status >= 500) {
          if (retryCount < this.maxRetries) {
            const waitTime = this.calculateBackoffDelay(retryCount);
            console.log(
              `Server error. Retrying in ${waitTime}ms (attempt ${
                retryCount + 1
              }/${this.maxRetries})`
            );
            await this.sleep(waitTime);
            return this.makeRateLimitedRequest(requestData, retryCount + 1);
          }
        }

        const errorMessage = errorData.error?.message || response.statusText;
        throw new Error(
          `API request failed: ${response.status} - ${errorMessage}`
        );
      }

      const data = await response.json();

      // Check if we got a valid response
      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error("Invalid response format from OpenAI API");
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Request timed out. Please try again.");
      }

      if (error.name === "TypeError" && error.message.includes("fetch")) {
        if (retryCount < this.maxRetries) {
          const waitTime = this.calculateBackoffDelay(retryCount);
          console.log(
            `Network error. Retrying in ${waitTime}ms (attempt ${
              retryCount + 1
            }/${this.maxRetries})`
          );
          await this.sleep(waitTime);
          return this.makeRateLimitedRequest(requestData, retryCount + 1);
        } else {
          throw new Error(
            "Network error. Please check your internet connection."
          );
        }
      }
      throw error;
    }
  }

  async waitForRateLimit() {
    const timeSinceLastRequest = Date.now() - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await this.sleep(waitTime);
    }
  }

  calculateBackoffDelay(retryCount) {
    // Exponential backoff: 2^retryCount * 1000ms, with jitter
    const baseDelay = Math.pow(2, retryCount) * 1000;
    const jitter = Math.random() * 1000; // Add up to 1 second of jitter
    return Math.min(baseDelay + jitter, 30000); // Cap at 30 seconds
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  buildExplanationPrompt(code, language, context) {
    let prompt = `Please explain the following ${
      language || "code"
    } snippet:\n\n\`\`\`${language || ""}\n${code}\n\`\`\`\n\n`;

    if (context) {
      prompt += `Context: ${context}\n\n`;
    }

    prompt += `Please provide:
1. A brief overview of what this code does
2. Line-by-line explanation of key parts
3. Any important concepts or patterns used
4. Potential improvements or considerations`;

    return prompt;
  }
}

class BackgroundService {
  constructor() {
    this.activeRequests = new Map(); // Track active requests
    this.init();
  }

  async init() {
    this.setupEventListeners();
    this.setupContextMenus();
    await this.initializeStorage();
  }

  setupEventListeners() {
    // Handle extension installation
    chrome.runtime.onInstalled.addListener((details) => {
      this.handleInstallation(details);
    });

    // Handle messages from content scripts and popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      // Use async wrapper to handle promises properly
      this.handleMessageAsync(request, sender, sendResponse);
      return true; // Keep message channel open for async responses
    });

    // Handle tab updates
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      this.handleTabUpdate(tabId, changeInfo, tab);
    });

    // Handle keyboard shortcuts, only if chrome.commands is available
    if (chrome.commands && chrome.commands.onCommand) {
      chrome.commands.onCommand.addListener((command) => {
        this.handleCommand(command);
      });
    }

    // Handle tab removal to clean up
    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
      // Clean up any active requests for this tab
      for (const [requestId, request] of this.activeRequests.entries()) {
        if (request.tabId === tabId) {
          this.activeRequests.delete(requestId);
        }
      }
      console.log(`Tab ${tabId} was removed and cleaned up`);
    });
  }

  // Async wrapper for message handling
  async handleMessageAsync(request, sender, sendResponse) {
    try {
      const result = await this.handleMessage(request, sender);
      sendResponse(result);
    } catch (error) {
      console.error("Background script error:", error);
      sendResponse({ error: error.message });
    }
  }

  async handleMessage(request, sender) {
    console.log("Background received message:", request.action);

    // Create unique request ID for tracking
    const requestId = `${Date.now()}_${Math.random()}`;
    this.activeRequests.set(requestId, {
      action: request.action,
      timestamp: Date.now(),
      tabId: sender.tab?.id,
    });

    try {
      let result;

      switch (request.action) {
        case "ping":
          result = { status: "pong" };
          break;

        case "checkApiKey":
          const hasApiKey = await this.checkApiKey();
          result = { hasApiKey };
          break;

        case "explainCode":
          const explanation = await this.explainCode(request, sender);
          result = { explanation };
          break;

        case "explainSelectedText":
          const explanation2 = await this.explainCode(
            {
              code: request.text,
              language: request.language,
              context: request.context,
            },
            sender
          );
          result = { explanation: explanation2 };
          break;

        case "askFollowUp":
          const answer = await this.askFollowUp(request);
          result = { answer };
          break;

        case "saveExplanation":
          await this.saveExplanation(request.explanation);
          result = { success: true };
          break;

        case "getHistory":
          const history = await this.getExplanationHistory();
          result = { history };
          break;

        case "updateStats":
          await this.updateUsageStats(request.stats);
          result = { success: true };
          break;

        case "clearHistory":
          await this.clearHistory();
          result = { success: true };
          break;

        case "exportData":
          const data = await this.exportUserData();
          result = { data };
          break;

        case "injectContentScript":
          const injected = await this.injectContentScript(sender.tab?.id);
          result = { success: injected };
          break;

        case "contentScriptReady":
          console.log("Content script ready on tab:", sender.tab?.id);
          result = { status: "acknowledged" };
          break;

        default:
          console.warn("Unknown action:", request.action);
          result = { error: "Unknown action" };
      }

      return result;
    } finally {
      // Clean up request tracking
      this.activeRequests.delete(requestId);
    }
  }

  setupContextMenus() {
    if (chrome.contextMenus && chrome.contextMenus.removeAll) {
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
          id: "explainCode",
          title: "Explain this code",
          contexts: ["selection"],
          documentUrlPatterns: ["http://*/*", "https://*/*"],
        });

        chrome.contextMenus.create({
          id: "explainCodeElement",
          title: "Explain code on this page",
          contexts: ["page"],
          documentUrlPatterns: ["http://*/*", "https://*/*"],
        });
      });

      chrome.contextMenus.onClicked.addListener((info, tab) => {
        this.handleContextMenuClick(info, tab);
      });
    }
  }

  async initializeStorage() {
    const defaultSettings = {
      openaiApiKey: "",
      model: "gpt-3.5-turbo",
      apiProvider: "openai",
      temperature: 0.7,
      maxTokens: 1000,
      autoDetectLanguage: true,
      showFloatingButton: true,
      explainOnSelect: false,
      theme: "dark",
      sidebarWidth: 450,
      explanationHistory: [],
      usageStats: {
        totalExplanations: 0,
        languagesUsed: {},
        lastUsed: null,
      },
    };

    const stored = await chrome.storage.sync.get(Object.keys(defaultSettings));
    const settings = { ...defaultSettings, ...stored };

    await chrome.storage.sync.set(settings);
  }

  async handleInstallation(details) {
    if (details.reason === "install") {
      // Open welcome page
      chrome.tabs.create({
        url: chrome.runtime.getURL("popup.html#welcome"),
      });

      // Track installation
      await this.trackEvent("extension_installed");
    } else if (details.reason === "update") {
      // Handle updates
      await this.trackEvent("extension_updated", {
        previousVersion: details.previousVersion,
      });
    }
  }

  async checkApiKey() {
    try {
      const result = await chrome.storage.sync.get(["openaiApiKey"]);
      const apiKey = result.openaiApiKey;
      console.log(
        "API Key check - exists:",
        !!apiKey,
        "length:",
        apiKey?.length
      );
      return !!(apiKey && apiKey.trim().length > 0);
    } catch (error) {
      console.error("Error checking API key:", error);
      return false;
    }
  }

  async explainCode(request, sender) {
    const { code, language, context } = request;

    console.log("Explaining code:", {
      codeLength: code?.length,
      language,
      hasContext: !!context,
    });

    // Input validation
    if (!code || code.trim().length === 0) {
      throw new Error("No code provided for explanation");
    }

    if (code.length > 10000) {
      throw new Error(
        "Code snippet too long. Please select a smaller portion."
      );
    }

    // Get settings
    const settings = await chrome.storage.sync.get([
      "openaiApiKey",
      "model",
      "apiProvider",
      "temperature",
      "maxTokens",
    ]);

    console.log("Retrieved settings:", {
      hasApiKey: !!settings.openaiApiKey,
      model: settings.model,
    });

    if (!settings.openaiApiKey || settings.openaiApiKey.trim() === "") {
      throw new Error(
        "API key not configured. Please set your OpenAI API key in the extension popup."
      );
    }

    try {
      // Create LangChain service instance
      const langChainService = new LangChainCodeExplainer(
        settings.openaiApiKey
      );

      // Get explanation with better error handling
      const explanation = await langChainService.explainCode(code, language, {
        model: settings.model || "gpt-3.5-turbo",
        temperature: settings.temperature || 0.7,
        maxTokens: settings.maxTokens || 1000,
        context,
      });

      console.log("Explanation generated successfully", {
        tokens: explanation.tokens,
      });

      // Update stats
      await this.updateUsageStats({
        language: language || "unknown",
        timestamp: Date.now(),
        tokens: explanation.tokens,
      });

      return {
        explanation: explanation.explanation,
        language: language || "unknown",
        timestamp: explanation.timestamp,
        tokens: explanation.tokens,
      };
    } catch (error) {
      console.error("Error explaining code:", error);

      // Provide more specific and user-friendly error messages
      if (error.message.includes("Rate limit exceeded")) {
        throw new Error(
          "You're making requests too quickly. Please wait a moment and try again. If this persists, check your OpenAI API usage limits."
        );
      } else if (
        error.message.includes("401") ||
        error.message.includes("Invalid API key")
      ) {
        throw new Error(
          "Invalid API key. Please check your OpenAI API key in the extension settings."
        );
      } else if (
        error.message.includes("403") ||
        error.message.includes("forbidden")
      ) {
        throw new Error(
          "API access forbidden. Your API key may not have the required permissions."
        );
      } else if (error.message.includes("insufficient_quota")) {
        throw new Error(
          "API quota exceeded. Please check your OpenAI account billing and usage limits."
        );
      } else if (error.message.includes("Network error")) {
        throw new Error(
          "Network connection failed. Please check your internet connection and try again."
        );
      } else if (error.message.includes("timeout")) {
        throw new Error(
          "Request timed out. The API is taking too long to respond. Please try again."
        );
      } else {
        throw new Error(`Failed to explain code: ${error.message}`);
      }
    }
  }

  async askFollowUp(request) {
    const { question, originalCode, originalExplanation } = request;

    if (!question || question.trim().length === 0) {
      throw new Error("No question provided");
    }

    const settings = await chrome.storage.sync.get(["openaiApiKey", "model"]);

    if (!settings.openaiApiKey) {
      throw new Error("API key not configured");
    }

    try {
      const langChainService = new LangChainCodeExplainer(
        settings.openaiApiKey
      );
      const answer = await langChainService.askFollowUp(
        question,
        originalCode,
        originalExplanation
      );

      // Update stats for follow-up questions
      await this.updateUsageStats({
        language: "follow-up",
        timestamp: Date.now(),
        tokens: answer.tokens,
      });

      return answer;
    } catch (error) {
      console.error("Error asking follow-up:", error);

      // Use the same error handling pattern
      if (error.message.includes("Rate limit exceeded")) {
        throw new Error(
          "You're making requests too quickly. Please wait a moment and try again."
        );
      } else if (
        error.message.includes("401") ||
        error.message.includes("Invalid API key")
      ) {
        throw new Error(
          "Invalid API key. Please check your OpenAI API key in the extension settings."
        );
      } else if (error.message.includes("Network error")) {
        throw new Error(
          "Network connection failed. Please check your internet connection and try again."
        );
      } else {
        throw new Error(`Failed to get follow-up answer: ${error.message}`);
      }
    }
  }

  async saveExplanation(explanation) {
    const { explanationHistory } = await chrome.storage.sync.get([
      "explanationHistory",
    ]);

    const newEntry = {
      id: Date.now().toString(),
      explanation: explanation.explanation || explanation,
      code: explanation.code || "",
      language: explanation.language || "unknown",
      timestamp: explanation.timestamp || Date.now(),
      tokens: explanation.tokens || 0,
    };

    const updatedHistory = [newEntry, ...(explanationHistory || [])].slice(
      0,
      100
    ); // Keep last 100

    await chrome.storage.sync.set({ explanationHistory: updatedHistory });
    console.log("Explanation saved to history");
  }

  async getExplanationHistory() {
    const { explanationHistory } = await chrome.storage.sync.get([
      "explanationHistory",
    ]);
    return explanationHistory || [];
  }

  async updateUsageStats(stats) {
    const { usageStats } = await chrome.storage.sync.get(["usageStats"]);

    const currentStats = usageStats || {
      totalExplanations: 0,
      languagesUsed: {},
      lastUsed: null,
      totalTokens: 0,
      dailyUsage: {},
    };

    // Update stats
    currentStats.totalExplanations += 1;
    currentStats.lastUsed = stats.timestamp || Date.now();
    currentStats.totalTokens =
      (currentStats.totalTokens || 0) + (stats.tokens || 0);

    // Track daily usage for rate limiting insights
    const today = new Date().toISOString().split("T")[0];
    if (!currentStats.dailyUsage[today]) {
      currentStats.dailyUsage[today] = { requests: 0, tokens: 0 };
    }
    currentStats.dailyUsage[today].requests += 1;
    currentStats.dailyUsage[today].tokens += stats.tokens || 0;

    // Clean up old daily usage data (keep only last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffDate = thirtyDaysAgo.toISOString().split("T")[0];

    for (const date in currentStats.dailyUsage) {
      if (date < cutoffDate) {
        delete currentStats.dailyUsage[date];
      }
    }

    if (stats.language) {
      currentStats.languagesUsed[stats.language] =
        (currentStats.languagesUsed[stats.language] || 0) + 1;
    }

    await chrome.storage.sync.set({ usageStats: currentStats });
    console.log("Usage stats updated:", {
      total: currentStats.totalExplanations,
      todayRequests: currentStats.dailyUsage[today]?.requests,
      todayTokens: currentStats.dailyUsage[today]?.tokens,
    });
  }

  async clearHistory() {
    await chrome.storage.sync.set({ explanationHistory: [] });
    console.log("Explanation history cleared");
  }

  async exportUserData() {
    const data = await chrome.storage.sync.get(null);

    // Remove sensitive data
    const exportData = { ...data };
    delete exportData.openaiApiKey;

    return {
      exportedAt: new Date().toISOString(),
      version: chrome.runtime.getManifest().version,
      data: exportData,
    };
  }

  async injectContentScript(tabId) {
    if (!tabId) return false;
    return await injectContentScript(tabId);
  }

  async handleTabUpdate(tabId, changeInfo, tab) {
    // Handle tab updates if needed
    if (changeInfo.status === "complete" && tab.url) {
      console.log(`Tab ${tabId} finished loading: ${tab.url}`);

      // Optionally inject content script on page load based on settings
      const { showFloatingButton } = await chrome.storage.sync.get([
        "showFloatingButton",
      ]);
      if (showFloatingButton) {
        // Could auto-inject content script here if needed
      }
    }
  }

  async handleCommand(command) {
    console.log(`Command received: ${command}`);

    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!activeTab) return;

      switch (command) {
        case "explain-selected-code":
          await safeMessageSend(activeTab.id, {
            action: "explainSelectedCode",
          });
          break;

        case "toggle-sidebar":
          await safeMessageSend(activeTab.id, {
            action: "toggleSidebar",
          });
          break;

        default:
          console.warn(`Unknown command: ${command}`);
      }
    } catch (error) {
      console.error("Error handling command:", error);
    }
  }

  async handleContextMenuClick(info, tab) {
    console.log("Context menu clicked:", info.menuItemId);

    try {
      switch (info.menuItemId) {
        case "explainCode":
          if (info.selectionText) {
            await safeMessageSend(tab.id, {
              action: "explainSelectedText",
              text: info.selectionText,
            });
          }
          break;

        case "explainCodeElement":
          await safeMessageSend(tab.id, {
            action: "showCodeSelector",
          });
          break;

        default:
          console.warn(`Unknown context menu item: ${info.menuItemId}`);
      }
    } catch (error) {
      console.error("Error handling context menu click:", error);
    }
  }

  async trackEvent(eventName, data = {}) {
    // Simple event tracking - could be extended to use analytics
    console.log(`Event tracked: ${eventName}`, data);

    // Could save to storage for analytics
    const { analytics } = await chrome.storage.local.get(["analytics"]);
    const events = analytics?.events || [];

    events.push({
      event: eventName,
      data,
      timestamp: Date.now(),
    });

    // Keep only last 1000 events
    const trimmedEvents = events.slice(-1000);

    await chrome.storage.local.set({
      analytics: {
        events: trimmedEvents,
        lastUpdated: Date.now(),
      },
    });
  }

  // Health check method
  getHealthStatus() {
    return {
      activeRequests: this.activeRequests.size,
      uptime: Date.now() - (this.startTime || Date.now()),
      status: "healthy",
    };
  }
}

// Initialize the background service
const backgroundService = new BackgroundService();
backgroundService.startTime = Date.now();

// Keep service worker alive with periodic ping
let keepAliveTimer;
function keepServiceWorkerAlive() {
  console.log("Service worker keepalive ping");
  if (keepAliveTimer) {
    clearTimeout(keepAliveTimer);
  }
  keepAliveTimer = setTimeout(keepServiceWorkerAlive, 25000); // 25 seconds
}

// Start keepalive
keepServiceWorkerAlive();

// Handle service worker lifecycle
chrome.runtime.onStartup.addListener(() => {
  console.log("Extension startup");
  keepServiceWorkerAlive();
});

self.addEventListener("install", (event) => {
  console.log("Service worker installing");
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("Service worker activating");
  event.waitUntil(self.clients.claim());
});

// Export for testing if needed
if (typeof module !== "undefined" && module.exports) {
  module.exports = { BackgroundService, LangChainCodeExplainer };
}
