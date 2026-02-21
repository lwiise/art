async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body?.error || "Request failed.";
    throw new Error(message);
  }
  return body;
}

async function signOutCurrentUser(redirectTo = "/log") {
  await apiRequest("/api/auth/signout", { method: "POST" });
  window.location.href = redirectTo;
}

function attachSignOutHandler(buttonId, redirectTo = "/log") {
  const button = document.getElementById(buttonId);
  if (!button) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await signOutCurrentUser(redirectTo);
    } catch (err) {
      alert(err.message || "Could not sign out.");
      button.disabled = false;
    }
  });
}

window.APP = {
  apiRequest,
  attachSignOutHandler,
};
