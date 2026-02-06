/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const contextStatus = document.getElementById("context-status");
const presenceStatus = document.getElementById("presence-status");
const addressInput = document.getElementById("address-input");
const addressButton = document.getElementById("address-button");
const addressStatus = document.getElementById("address-status");
const addressResults = document.getElementById("address-results");

// Configuration
const MAX_MESSAGE_LENGTH = 10000; // Maximum characters per message
const REQUEST_TIMEOUT = 30000; // Request timeout in milliseconds (30 seconds - faster model)
const ADDRESS_LOOKUP_ENDPOINT = "/api/address-lookup";

// Chat state
const initialAssistantMessage =
  "Hi! This is a test chat experience. Nothing here is stored or saved. You can also run quick address lookups above. How can I help you today?";

let chatHistory = [
  {
    role: "assistant",
    content: initialAssistantMessage,
  },
];
let isProcessing = false;

updateContextStatus();
addMessageToChat("assistant", initialAssistantMessage);

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);
addressButton.addEventListener("click", handleAddressLookup);

addressInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    event.preventDefault();
    handleAddressLookup();
  }
});

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
  const message = userInput.value.trim();

  // Don't send empty messages
  if (message === "" || isProcessing) return;

  // Validate message length
  if (message.length > MAX_MESSAGE_LENGTH) {
    addMessageToChat(
      "assistant",
      `Sorry, your message is too long. Please keep it under ${MAX_MESSAGE_LENGTH} characters. (Current: ${message.length})`,
    );
    return;
  }

  // Disable input while processing
  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;
  sendButton.classList.add("is-sending");
  updatePresenceStatus("Thinking…");

  // Add user message to chat
  addMessageToChat("user", message);

  // Clear input
  userInput.value = "";
  userInput.style.height = "auto";

  // Show typing indicator
  typingIndicator.classList.add("visible");

  // Add message to history
  chatHistory.push({ role: "user", content: message });

  try {
    // Create new assistant response element
    const assistantMessageEl = createMessageElement("assistant", "");
    const assistantParagraph = assistantMessageEl.querySelector("p");
    chatMessages.appendChild(assistantMessageEl);

    // Optimized scroll to bottom using requestAnimationFrame
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });

    // Set up timeout handling
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT);

    try {
      // Send request to API
      const payload = {
        messages: chatHistory,
        clientContext: getClientContext(),
      };

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      // Clear timeout if request completes
      clearTimeout(timeoutId);

      // Handle errors
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Server error: ${response.status}`);
      }

      if (!response.body) {
        throw new Error("Streaming response unavailable");
      }

      // Process streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let responseText = "";
      let buffer = ""; // Buffer for incomplete JSON lines
      let scrollScheduled = false;

      // Optimized scroll function using requestAnimationFrame
      const scheduleScroll = () => {
        if (!scrollScheduled) {
          scrollScheduled = true;
          requestAnimationFrame(() => {
            chatMessages.scrollTop = chatMessages.scrollHeight;
            scrollScheduled = false;
          });
        }
      };

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Decode chunk
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // Process complete lines (split by newline)
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          // Skip empty lines
          if (trimmedLine === "") continue;

          try {
            const jsonData = JSON.parse(trimmedLine);
            if (jsonData.response) {
              // Append new content to existing text
              responseText += jsonData.response;
              assistantParagraph.textContent = responseText;

              // Optimized scroll to bottom
              scheduleScroll();
            }
          } catch (e) {
            // Only log non-empty parsing errors
            if (trimmedLine) {
              console.error("Error parsing JSON line:", trimmedLine, e);
            }
          }
        }
      }

      // Process any remaining buffered content
      if (buffer.trim()) {
        try {
          const jsonData = JSON.parse(buffer.trim());
          if (jsonData.response) {
            responseText += jsonData.response;
            assistantParagraph.textContent = responseText;
          }
        } catch (e) {
          console.error("Error parsing final buffered JSON:", buffer, e);
        }
      }

      // Add completed response to chat history
      if (responseText) {
        chatHistory.push({ role: "assistant", content: responseText });
      } else {
        // Handle case where no response was received
        throw new Error("No response received from server");
      }
    } catch (innerError) {
      // Clear timeout on error
      clearTimeout(timeoutId);
      throw innerError;
    }
  } catch (error) {
    console.error("Error:", error);
    let errorMessage = "Sorry, there was an error processing your request.";

    if (error.name === "AbortError") {
      errorMessage = "Request timed out. Please try again.";
    } else if (error.message) {
      errorMessage = `Error: ${error.message}`;
    }

    addMessageToChat("assistant", errorMessage);
  } finally {
    // Hide typing indicator
    typingIndicator.classList.remove("visible");

    // Re-enable input
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    sendButton.classList.remove("is-sending");
    updatePresenceStatus("Ready");
    userInput.focus();
  }
}

async function handleAddressLookup() {
  const query = addressInput.value.trim();

  if (!query) {
    addressStatus.textContent = "Enter an address to search.";
    return;
  }

  addressButton.disabled = true;
  addressInput.disabled = true;
  addressStatus.textContent = "Looking up address…";
  addressResults.innerHTML = "";

  try {
    const response = await fetch(
      `${ADDRESS_LOOKUP_ENDPOINT}?q=${encodeURIComponent(query)}`,
      {
        headers: { Accept: "application/json" },
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || "Lookup failed.");
    }

    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];

    if (results.length === 0) {
      addressStatus.textContent = "No matches found. Try a different address.";
      return;
    }

    addressStatus.textContent = `Found ${results.length} result${
      results.length === 1 ? "" : "s"
    }.`;

    results.forEach((item) => {
      const listItem = document.createElement("li");
      listItem.className = "lookup-result";

      const title = document.createElement("strong");
      title.textContent = item.displayName || "Unknown location";

      const meta = document.createElement("div");
      meta.className = "lookup-meta";
      const lat = item.lat ? Number(item.lat).toFixed(6) : "—";
      const lon = item.lon ? Number(item.lon).toFixed(6) : "—";
      const typeLabel = item.type ? ` · ${item.type}` : "";
      meta.textContent = `Lat ${lat}, Lon ${lon}${typeLabel}`;

      listItem.appendChild(title);
      listItem.appendChild(meta);
      addressResults.appendChild(listItem);
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Unable to lookup this address.";
    addressStatus.textContent = message;
  } finally {
    addressButton.disabled = false;
    addressInput.disabled = false;
    addressInput.focus();
  }
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
  const messageEl = createMessageElement(role, content);
  chatMessages.appendChild(messageEl);

  // Optimized scroll to bottom using requestAnimationFrame
  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

function createMessageElement(role, content) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;

  const header = document.createElement("div");
  header.className = "message-header";

  const timestamp = document.createElement("span");
  timestamp.className = "message-timestamp";
  timestamp.textContent = formatTimestamp(new Date());

  header.appendChild(timestamp);
  messageEl.appendChild(header);

  const paragraph = document.createElement("p");
  paragraph.textContent = content;
  messageEl.appendChild(paragraph);

  return messageEl;
}

function formatTimestamp(date) {
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function getClientContext() {
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";
  const locale = navigator.language || "Unknown";

  return {
    currentTimeIso: new Date().toISOString(),
    timeZone,
    locale,
    userAgent: navigator.userAgent,
  };
}

function updateContextStatus() {
  if (!contextStatus) return;

  const context = getClientContext();
  contextStatus.textContent = `Local time synced (${context.timeZone})`;
}

function updatePresenceStatus(text) {
  if (!presenceStatus) return;
  presenceStatus.textContent = text;
  presenceStatus.classList.toggle("active", text !== "Ready");
}
