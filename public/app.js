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

async function getCurrentUser() {
  try {
    const response = await fetch("/api/me", {
      method: "GET",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && payload.user ? payload.user : null;
  } catch {
    return null;
  }
}

async function signOutCurrentUser(redirectTo = "/signin") {
  await apiRequest("/api/auth/signout", { method: "POST" });
  window.location.href = redirectTo;
}

function attachSignOutHandler(buttonId, redirectTo = "/signin") {
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

function makeNavLink(label, href) {
  const link = document.createElement("a");
  link.className = "btn-link";
  link.href = href;
  link.textContent = label;
  return link;
}

function makeSignOutButton(redirectTo = "/") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Sign out";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await signOutCurrentUser(redirectTo);
    } catch (error) {
      alert(error.message || "Could not sign out.");
      button.disabled = false;
    }
  });
  return button;
}

async function mountAuthNav(containerId, options = {}) {
  const root = typeof containerId === "string"
    ? document.getElementById(containerId)
    : containerId;
  if (!root) return null;

  const returnTo = options.returnTo || `${window.location.pathname}${window.location.search}`;
  const signInHref = `/signin?returnTo=${encodeURIComponent(returnTo)}`;
  const user = await getCurrentUser();

  root.innerHTML = "";
  if (!user) {
    root.appendChild(makeNavLink("Sign in", signInHref));
    root.appendChild(makeNavLink("Sign up", "/signup"));
    return null;
  }

  if (user.role === "user") {
    root.appendChild(makeNavLink("Dashboard", "/dashboard"));
  } else if (user.role === "vendor") {
    root.appendChild(makeNavLink("Vendor Dashboard", "/vendor"));
  } else if (user.role === "admin") {
    root.appendChild(makeNavLink("Admin", "/admin"));
  }
  root.appendChild(makeSignOutButton(options.signoutRedirect || "/"));
  return user;
}

window.APP = {
  apiRequest,
  attachSignOutHandler,
  getCurrentUser,
  mountAuthNav,
};
