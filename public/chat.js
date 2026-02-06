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

// Address lookup DOM elements
const addressLookupBtn = document.getElementById("address-lookup-btn");
const addressModal = document.getElementById("address-modal");
const modalClose = document.getElementById("modal-close");
const addressInput = document.getElementById("address-input");
const lookupButton = document.getElementById("lookup-button");
const lookupResults = document.getElementById("lookup-results");

// License intake DOM elements
const licenseIntakeBtn = document.getElementById("license-intake-btn");
const licenseModal = document.getElementById("license-modal");
const licenseModalClose = document.getElementById("license-modal-close");
const licenseIntakeForm = document.getElementById("license-intake-form");
const licenseCompany = document.getElementById("license-company");
const licenseContact = document.getElementById("license-contact");
const licenseEmail = document.getElementById("license-email");
const licenseProduct = document.getElementById("license-product");
const licenseType = document.getElementById("license-type");
const licenseSeats = document.getElementById("license-seats");
const licenseStart = document.getElementById("license-start");
const licenseRenewal = document.getElementById("license-renewal");
const licenseNotes = document.getElementById("license-notes");

// Configuration
const MAX_MESSAGE_LENGTH = 10000; // Maximum characters per message
const REQUEST_TIMEOUT = 30000; // Request timeout in milliseconds (30 seconds - faster model)

// Chat state
const initialAssistantMessage =
  "Hi! This is a test application powered by Cloudflare Workers AI. Please note that nothing here is kept or saved - this is purely for test purposes. How can I help you today?";

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

// ── Address Lookup ──────────────────────────────────────────────────

let isLookingUp = false;

function openAddressModal() {
  addressModal.classList.add("visible");
  addressInput.focus();
}

function closeAddressModal() {
  addressModal.classList.remove("visible");
}

addressLookupBtn.addEventListener("click", openAddressModal);
modalClose.addEventListener("click", closeAddressModal);

// Close modal when clicking overlay background
addressModal.addEventListener("click", function (e) {
  if (e.target === addressModal) {
    closeAddressModal();
  }
});

// Close modal on Escape key
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  if (addressModal.classList.contains("visible")) {
    closeAddressModal();
  }
  if (licenseModal.classList.contains("visible")) {
    closeLicenseModal();
  }
});

// Submit on Enter in address input
addressInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    e.preventDefault();
    performAddressLookup();
  }
});

lookupButton.addEventListener("click", performAddressLookup);

// ── License Intake ────────────────────────────────────────────────

function openLicenseModal() {
  licenseModal.classList.add("visible");
  licenseCompany.focus();
}

function closeLicenseModal() {
  licenseModal.classList.remove("visible");
}

licenseIntakeBtn.addEventListener("click", openLicenseModal);
licenseModalClose.addEventListener("click", closeLicenseModal);

licenseModal.addEventListener("click", function (e) {
  if (e.target === licenseModal) {
    closeLicenseModal();
  }
});

licenseIntakeForm.addEventListener("submit", function (e) {
  e.preventDefault();

  if (!licenseIntakeForm.reportValidity()) return;

  const summaryLines = [
    "License intake summary:",
    `- Company: ${licenseCompany.value.trim()}`,
    `- Primary contact: ${licenseContact.value.trim()}`,
    `- Contact email: ${licenseEmail.value.trim()}`,
    `- Product/platform: ${licenseProduct.value.trim()}`,
    `- License type: ${licenseType.value}`,
  ];

  const seatsValue = licenseSeats.value.trim();
  if (seatsValue) {
    summaryLines.push(`- Seat/usage volume: ${seatsValue}`);
  }

  if (licenseStart.value) {
    summaryLines.push(`- Start date: ${licenseStart.value}`);
  }

  if (licenseRenewal.value) {
    summaryLines.push(`- Renewal date: ${licenseRenewal.value}`);
  }

  const notesValue = licenseNotes.value.trim();
  if (notesValue) {
    summaryLines.push(`- Notes: ${notesValue}`);
  }

  userInput.value = summaryLines.join("\n");
  userInput.dispatchEvent(new Event("input", { bubbles: true }));
  closeLicenseModal();
  userInput.focus();
});

async function performAddressLookup() {
  const address = addressInput.value.trim();
  if (!address || isLookingUp) return;

  if (address.length > 500) {
    lookupResults.textContent =
      "Address is too long. Please keep it under 500 characters.";
    lookupResults.classList.add("visible", "error");
    return;
  }

  isLookingUp = true;
  lookupButton.disabled = true;
  addressInput.disabled = true;
  lookupResults.textContent = "";
  lookupResults.classList.remove("error");
  lookupResults.classList.add("visible");

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch("/api/address-lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address,
        clientContext: getClientContext(),
      }),
      signal: abortController.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Server error: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("Streaming response unavailable");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let resultText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine === "") continue;

        try {
          const jsonData = JSON.parse(trimmedLine);
          if (jsonData.response) {
            resultText += jsonData.response;
            lookupResults.textContent = resultText;
          }
        } catch (e) {
          if (trimmedLine) {
            console.error("Error parsing address lookup JSON:", trimmedLine, e);
          }
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const jsonData = JSON.parse(buffer.trim());
        if (jsonData.response) {
          resultText += jsonData.response;
          lookupResults.textContent = resultText;
        }
      } catch (e) {
        console.error("Error parsing final address lookup buffer:", buffer, e);
      }
    }

    if (!resultText) {
      throw new Error("No response received from server");
    }
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("Address lookup error:", error);

    let errorMessage = "Sorry, there was an error looking up the address.";
    if (error.name === "AbortError") {
      errorMessage = "Request timed out. Please try again.";
    } else if (error.message) {
      errorMessage = `Error: ${error.message}`;
    }

    lookupResults.textContent = errorMessage;
    lookupResults.classList.add("error");
  } finally {
    isLookingUp = false;
    lookupButton.disabled = false;
    addressInput.disabled = false;
    addressInput.focus();
  }
}
