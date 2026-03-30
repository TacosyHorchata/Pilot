const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const hint = document.getElementById('hint');

// Ask background if connected
chrome.runtime.sendMessage({ type: 'ping' }, (response) => {
  if (chrome.runtime.lastError || !response?.pong) {
    setDisconnected();
  } else {
    setConnected();
  }
});

function setConnected() {
  dot.className = 'dot connected';
  statusText.textContent = 'Connected to Pilot MCP';
  hint.textContent = 'Claude Code can now control this browser.';
}

function setDisconnected() {
  dot.className = 'dot disconnected';
  statusText.textContent = 'Not connected';
  hint.textContent = 'Start Pilot MCP in Claude Code, then reload this popup.';
}
