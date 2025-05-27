class PopupManager {
  constructor() {
    this.currentTab = "setup";
    this.init();
  }

  async init() {
    this.setupEventListeners();
    await this.loadStoredData();
    this.updateStats();
    this.loadHistory();
  }

  setupEventListeners() {
    // Tab switching
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", (e) => {
        this.switchTab(e.target.dataset.tab);
      });
    });

    // API key management
    document.getElementById("save-api-key").addEventListener("click", () => {
      this.saveApiKey();
    });

    // Quick actions
    document.getElementById("explain-current").addEventListener("click", () => {
      this.explainCurrentSelection();
    });

    document.getElementById("toggle-sidebar").addEventListener("click", () => {
      this.toggleSidebar();
    });

    document.getElementById("open-history").addEventListener("click", () => {
      this.switchTab("history");
    });

    // Settings
    document
      .getElementById("auto-detect-code")
      .addEventListener("change", (e) => {
        this.saveSetting("autoDetectCode", e.target.checked);
      });

    document
      .getElementById("show-floating-button")
      .addEventListener("change", (e) => {
        this.saveSetting("showFloatingButton", e.target.checked);
      });

    document.getElementById("save-history").addEventListener("change", (e) => {
      this.saveSetting("saveHistory", e.target.checked);
    });

    document.getElementById("model-select").addEventListener("change", (e) => {
      this.saveSetting("selectedModel", e.target.value);
    });

    document.getElementById("detail-level").addEventListener("change", (e) => {
      this.saveSetting("detailLevel", e.target.value);
    });

    // Data management
    document.getElementById("clear-history").addEventListener("click", () => {
      this.clearHistory();
    });

    document.getElementById("export-data").addEventListener("click", () => {
      this.exportData();
    });

    // Test API key on input
    document.getElementById("api-key").addEventListener(
      "input",
      this.debounce(() => this.testApiKey(), 1000)
    );
  }

  switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.remove("active");
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add("active");

    // Update tab content
    document.querySelectorAll(".tab-content").forEach((content) => {
      content.classList.remove("active");
    });
    document.getElementById(`${tabName}-tab`).classList.add("active");

    this.currentTab = tabName;

    // Load tab-specific data
    if (tabName === "history") {
      this.loadHistory();
    }
  }

  async saveApiKey() {
    const apiKey = document.getElementById("api-key").value.trim();
    const statusDiv = document.getElementById("api-status");

    if (!apiKey) {
      this.showStatus("Please enter an API key", "error");
      return;
    }

    // Validate API key format
    if (!apiKey.startsWith("sk-") || apiKey.length < 40) {
      this.showStatus("Invalid API key format", "error");
      return;
    }

    try {
      // Test the API key
      const isValid = await this.testApiKeyRequest(apiKey);

      if (isValid) {
        await chrome.storage.sync.set({ openaiApiKey: apiKey });
        this.showStatus("API key saved successfully!", "success");

        // Notify content script
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab && this.isValidContentScriptTab(tab)) {
          chrome.tabs
            .sendMessage(tab.id, { action: "apiKeyUpdated", apiKey })
            .catch(() => {
              // Ignore error, content script may not exist
            });
        }
      } else {
        this.showStatus(
          "Invalid API key. Please check and try again.",
          "error"
        );
      }
    } catch (error) {
      console.error("Error saving API key:", error);
      this.showStatus("Error validating API key", "error");
    }
  }

  async testApiKeyRequest(apiKey) {
    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async testApiKey() {
    const apiKey = document.getElementById("api-key").value.trim();
    if (!apiKey || apiKey.length < 40) return;

    const isValid = await this.testApiKeyRequest(apiKey);
    if (isValid) {
      document.getElementById("api-key").style.borderColor =
        "rgba(76, 175, 80, 0.5)";
    } else {
      document.getElementById("api-key").style.borderColor =
        "rgba(244, 67, 54, 0.5)";
    }
  }

  showStatus(message, type) {
    const statusDiv = document.getElementById("api-status");
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.classList.remove("hidden");

    setTimeout(() => {
      statusDiv.classList.add("hidden");
    }, 3000);
  }

  async loadStoredData() {
    try {
      // Load API key
      const { openaiApiKey } = await chrome.storage.sync.get(["openaiApiKey"]);
      if (openaiApiKey) {
        document.getElementById("api-key").value = openaiApiKey;
      }

      // Load settings
      const settings = await chrome.storage.sync.get([
        "autoDetectCode",
        "showFloatingButton",
        "saveHistory",
        "selectedModel",
        "detailLevel",
      ]);

      document.getElementById("auto-detect-code").checked =
        settings.autoDetectCode !== false;
      document.getElementById("show-floating-button").checked =
        settings.showFloatingButton !== false;
      document.getElementById("save-history").checked =
        settings.saveHistory !== false;
      document.getElementById("model-select").value =
        settings.selectedModel || "gpt-4";
      document.getElementById("detail-level").value =
        settings.detailLevel || "intermediate";
    } catch (error) {
      console.error("Error loading stored data:", error);
    }
  }

  async saveSetting(key, value) {
    try {
      await chrome.storage.sync.set({ [key]: value });
    } catch (error) {
      console.error("Error saving setting:", error);
    }
  }

  // Utility to check if a tab is valid for content scripts
  isValidContentScriptTab(tab) {
    return (
      tab.url &&
      (tab.url.startsWith("http://") ||
        tab.url.startsWith("https://") ||
        tab.url.startsWith("file://"))
    );
  }

  async explainCurrentSelection() {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab && this.isValidContentScriptTab(tab)) {
        chrome.tabs
          .sendMessage(tab.id, { action: "explainSelected" })
          .catch(() => {
            this.showStatus("Cannot communicate with this page.", "error");
          });
        window.close(); // Close popup
      } else {
        this.showStatus(
          "This page does not support code explanation.",
          "error"
        );
      }
    } catch (error) {
      console.error("Error explaining current selection:", error);
    }
  }

  async toggleSidebar() {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab && this.isValidContentScriptTab(tab)) {
        chrome.tabs
          .sendMessage(tab.id, { action: "toggleSidebar" })
          .catch(() => {
            this.showStatus("Cannot communicate with this page.", "error");
          });
        window.close();
      } else {
        this.showStatus("This page does not support the sidebar.", "error");
      }
    } catch (error) {
      console.error("Error toggling sidebar:", error);
    }
  }

  async updateStats() {
    try {
      const { history = [], favorites = [] } = await chrome.storage.local.get([
        "history",
        "favorites",
      ]);

      const totalExplanations = history.length;
      const uniqueLanguages = new Set(history.map((item) => item.language))
        .size;
      const favoritesCount = favorites.length;

      document.getElementById("total-explanations").textContent =
        totalExplanations;
      document.getElementById("languages-detected").textContent =
        uniqueLanguages;
      document.getElementById("favorites-count").textContent = favoritesCount;
    } catch (error) {
      console.error("Error updating stats:", error);
    }
  }

  async loadHistory() {
    const historyList = document.getElementById("history-list");
    const loading = document.getElementById("history-loading");
    const noHistory = document.getElementById("no-history");

    try {
      loading.classList.remove("hidden");
      historyList.innerHTML = "";

      const { history = [] } = await chrome.storage.local.get(["history"]);

      if (history.length === 0) {
        loading.classList.add("hidden");
        noHistory.classList.remove("hidden");
        return;
      }

      // Display recent history items
      const recentHistory = history.slice(0, 10);
      recentHistory.forEach((item) => {
        const historyItem = this.createHistoryItem(item);
        historyList.appendChild(historyItem);
      });

      loading.classList.add("hidden");
      noHistory.classList.add("hidden");
    } catch (error) {
      console.error("Error loading history:", error);
      loading.classList.add("hidden");
    }
  }

  createHistoryItem(item) {
    const div = document.createElement("div");
    div.className = "history-item";

    const date = new Date(item.timestamp);
    const timeAgo = this.timeAgo(date);

    div.innerHTML = `
      <div class="language">${item.language}</div>
      <div class="code-preview">${this.escapeHtml(item.code.substring(0, 50))}${
      item.code.length > 50 ? "..." : ""
    }</div>
      <div style="font-size: 10px; opacity: 0.6; margin-top: 5px;">${timeAgo} • ${
      item.title
    }</div>
    `;

    div.addEventListener("click", () => {
      this.showHistoryDetails(item);
    });

    return div;
  }

  showHistoryDetails(item) {
    // Create a new tab or window to show full explanation
    const detailsUrl =
      chrome.runtime.getURL("history-details.html") +
      "?id=" +
      encodeURIComponent(item.id);
    chrome.tabs.create({ url: detailsUrl });
  }

  async clearHistory() {
    if (
      confirm(
        "Are you sure you want to clear all history? This cannot be undone."
      )
    ) {
      try {
        await chrome.storage.local.set({ history: [], favorites: [] });
        this.loadHistory();
        this.updateStats();
        this.showStatus("History cleared successfully", "success");
      } catch (error) {
        console.error("Error clearing history:", error);
        this.showStatus("Error clearing history", "error");
      }
    }
  }

  async exportData() {
    try {
      const data = await chrome.storage.local.get(["history", "favorites"]);
      const exportData = {
        history: data.history || [],
        favorites: data.favorites || [],
        exportDate: new Date().toISOString(),
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `code-explainer-data-${
        new Date().toISOString().split("T")[0]
      }.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.showStatus("Data exported successfully", "success");
    } catch (error) {
      console.error("Error exporting data:", error);
      this.showStatus("Error exporting data", "error");
    }
  }

  timeAgo(date) {
    const now = new Date();
    const diffInSeconds = Math.floor((now - date) / 1000);

    if (diffInSeconds < 60) return "Just now";

    const diffInMinutes = Math.floor(diffInSeconds / 60);
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`;

    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) return `${diffInHours}h ago`;

    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 7) return `${diffInDays}d ago`;

    return date.toLocaleDateString();
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
}

// Initialize popup when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new PopupManager();
});
