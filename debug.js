// Save API key to chrome.storage.sync
document.getElementById("saveKey").onclick = function () {
  const key = document.getElementById("apiKey").value.trim();
  chrome.storage.sync.set({ apiKey: key }, () => {
    show("API Key saved.");
  });
};

// Show stored API key
document.getElementById("showKey").onclick = function () {
  chrome.storage.sync.get(["apiKey"], (result) => {
    show(
      `Stored API Key: ${JSON.stringify(result.apiKey)}\nLength: ${
        result.apiKey?.length
      }\nStarts with sk-: ${result.apiKey?.startsWith("sk-")}`
    );
  });
};

// Clear API key
document.getElementById("clearKey").onclick = function () {
  chrome.storage.sync.remove(["apiKey"], () => {
    show("API Key cleared.");
  });
};

// Show all storage
document.getElementById("showAll").onclick = function () {
  chrome.storage.sync.get(null, (result) => {
    show(JSON.stringify(result, null, 2));
  });
};

function show(msg) {
  document.getElementById("output").textContent = msg;
}
