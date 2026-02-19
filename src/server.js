const path = require("path");
const bcrypt = require("bcryptjs");
const express = require("express");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const { createUser, db } = require("./db");
const {
  attachCurrentUser,
  buildSessionUser,
  clearSessionCookie,
  requireAdmin,
  requireAuth,
  setSessionCookie,
  signSessionToken,
} = require("./auth");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(attachCurrentUser);
const publicDir = path.join(__dirname, "..", "public");
app.use("/auth-assets", express.static(publicDir));
app.use(express.static(publicDir));

const WEBSITE_EDIT_TEMPLATE = Object.freeze({
  schema_version: "1.0",
  target: "full_website",
  sections: {
    home: {
      welcome: "",
      tagline: "",
      banner_title: "",
      banner_button: "",
      slides: [
        { image_url: "" },
        { image_url: "" },
        { image_url: "" }
      ]
    },
    about: {
      title: "",
      lead: "",
      sublead: "",
      cards: [
        { meta: "", title: "", description: "", image_url: "" },
        { meta: "", title: "", description: "", image_url: "" },
        { meta: "", title: "", description: "", image_url: "" }
      ]
    },
    services: {
      title: "",
      subtitle: "",
      items: [
        { icon: "", title: "", description: "" }
      ]
    },
    process: {
      title: "",
      subtitle: "",
      steps: [
        { kicker: "", title: "", description: "", illustration: "" }
      ]
    },
    gallery: {
      title: "",
      artists_button: "",
      tabs: {
        art: "Art",
        designs: "Designs",
        books: "Books",
        photography: "Photography"
      },
      art_types: ["Artwork", "Sculpture"],
      design_filters: ["All", "Cabinets", "Sideboards", "Decor"],
      book_filters: {
        themes: ["Heritage", "Pilgrimage", "Architecture", "Travel", "Culture"],
        colors: ["Warm", "Cool", "Neutral", "Bold"],
        sizes: ["Compact", "Classic", "Large"]
      }
    },
    contact: {
      title: "",
      subtitle: "",
      form_placeholders: {
        name: "",
        email: "",
        subject: "",
        message: ""
      },
      button: ""
    },
    footer: {
      brand: "",
      note: "",
      contact_title: "",
      contact: "",
      navigation_title: "",
      social_title: "",
      navigation: {
        home: "Home",
        about: "About",
        services: "Services",
        gallery: "Gallery",
        contact: "Contact"
      },
      social: ["", "", "", ""],
      copyright: ""
    }
  },
  products: [
    {
      action: "update",
      id: "existing-product-id-or-empty-for-create",
      name: "",
      gallery_type: "art",
      status: "active",
      sort_order: 0,
      category: "",
      image_url: "",
      media_images: [],
      model_url: "",
      artist: {
        name: "",
        role: "",
        image_url: "",
        bio: ""
      },
      book_fields: {
        theme: "",
        color: "",
        size: "",
        tag: "",
        kicker: ""
      },
      design_fields: {
        material: "",
        dimensions: "",
        store_name: "",
        store_lng: null,
        store_lat: null
      },
      art_fields: {
        medium: "",
        period: "",
        era: "",
        year: null,
        material: "",
        rating: null,
        rating_count: "",
        base_price: null
      }
    }
  ],
  notes: "Users can edit any field in this template and submit it as a pending change request."
});

const DEFAULT_SITE_STATE = Object.freeze({
  sections: {
    home: {
      title: "Welcome to FNN Art",
      subtitle: "The New Marketplace for Exceptional Art"
    },
    about: {
      title: "About FNN",
      lead: "A modern art platform presenting original works by selected artists."
    },
    services: {
      title: "Services",
      subtitle: "Creative direction, curation, and installation."
    },
    process: {
      title: "Our Process",
      subtitle: "From discovery to delivery with clear quality gates."
    },
    gallery: {
      title: "Gallery",
      artists_button: "Artists"
    },
    contact: {
      title: "Get in Touch",
      subtitle: "Interested in a piece? Let us know."
    },
    footer: {
      note: "A modern art platform connecting artists, institutions, and audiences.",
      contact: "anaskaroti@gmail.com"
    }
  },
  products: [
    {
      id: "prod-praying-girl",
      name: "Praying Girl (19th Century)",
      gallery_type: "art",
      category: "Artwork",
      status: "active",
      sort_order: 1,
      artist_name: "Roberto Ferruzzi",
      artist_role: "Painter",
      artist_image_url: "",
      artist_bio: "",
      image_url: "",
      model_url: "",
      description: ""
    },
    {
      id: "prod-arch-cabinet",
      name: "Arch Cabinet",
      gallery_type: "designs",
      category: "Cabinets",
      status: "active",
      sort_order: 2,
      artist_name: "",
      artist_role: "",
      artist_image_url: "",
      artist_bio: "",
      image_url: "",
      model_url: "",
      description: ""
    },
    {
      id: "prod-hajj-arts",
      name: "Hajj and the Arts of Pilgrimage",
      gallery_type: "books",
      category: "Books",
      status: "active",
      sort_order: 3,
      artist_name: "",
      artist_role: "",
      artist_image_url: "",
      artist_bio: "",
      image_url: "",
      model_url: "",
      description: ""
    }
  ]
});

function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeJsonParseText(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeSiteState(input) {
  const base = deepCloneJson(DEFAULT_SITE_STATE);
  if (!input || typeof input !== "object") {
    return base;
  }

  if (input.sections && typeof input.sections === "object" && !Array.isArray(input.sections)) {
    base.sections = input.sections;
  }

  if (Array.isArray(input.products)) {
    base.products = input.products.map((product, index) => {
      const p = (product && typeof product === "object") ? product : {};
      return {
        id: String(p.id || `prod-${Date.now()}-${index}`),
        name: String(p.name || "Untitled Product"),
        gallery_type: String(p.gallery_type || "art"),
        category: String(p.category || ""),
        status: String(p.status || "active"),
        sort_order: Number.isFinite(Number(p.sort_order)) ? Number(p.sort_order) : 0,
        artist_name: String(p.artist_name || ""),
        artist_role: String(p.artist_role || ""),
        artist_image_url: String(p.artist_image_url || ""),
        artist_bio: String(p.artist_bio || ""),
        image_url: String(p.image_url || ""),
        model_url: String(p.model_url || ""),
        description: String(p.description || ""),
      };
    });
  }

  return base;
}

function getSiteState() {
  const row = db
    .prepare("select sections_json, products_json from site_state where id = 1")
    .get();

  if (!row) {
    const fallback = deepCloneJson(DEFAULT_SITE_STATE);
    db.prepare(
      "insert into site_state (id, sections_json, products_json, updated_at) values (1, ?, ?, datetime('now'))"
    ).run(JSON.stringify(fallback.sections), JSON.stringify(fallback.products));
    return fallback;
  }

  return normalizeSiteState({
    sections: safeJsonParseText(row.sections_json, deepCloneJson(DEFAULT_SITE_STATE.sections)),
    products: safeJsonParseText(row.products_json, deepCloneJson(DEFAULT_SITE_STATE.products)),
  });
}

function saveSiteState(state, updatedBy) {
  const normalized = normalizeSiteState(state);
  db.prepare(
    `update site_state
     set sections_json = ?, products_json = ?, updated_at = datetime('now'), updated_by = ?
     where id = 1`
  ).run(
    JSON.stringify(normalized.sections),
    JSON.stringify(normalized.products),
    updatedBy || null
  );
  return normalized;
}

function applyPayloadToSiteState(payload, adminUserId) {
  if (!payload || typeof payload !== "object") return false;

  const current = getSiteState();
  const next = deepCloneJson(current);
  let changed = false;

  if (payload.sections && typeof payload.sections === "object" && !Array.isArray(payload.sections)) {
    next.sections = payload.sections;
    changed = true;
  }

  if (Array.isArray(payload.products)) {
    next.products = payload.products;
    changed = true;
  }

  if (changed) {
    saveSiteState(next, adminUserId);
  }
  return changed;
}

function normalizeStatus(status) {
  if (!status) return null;
  const value = String(status).trim().toLowerCase();
  if (["pending", "approved", "rejected"].includes(value)) {
    return value;
  }
  return null;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function serializeEditRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    title: row.title,
    description: row.description,
    payload: safeJsonParse(row.payload),
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name || null,
  };
}

function getEditById(editId) {
  const row = db
    .prepare(
      `select
        e.id,
        e.user_id,
        u.name as user_name,
        u.email as user_email,
        e.title,
        e.description,
        e.payload,
        e.status,
        e.created_at,
        e.approved_at,
        e.approved_by,
        a.name as approved_by_name
      from edits e
      join users u on u.id = e.user_id
      left join users a on a.id = e.approved_by
      where e.id = ?`
    )
    .get(editId);
  return serializeEditRow(row);
}

function listEditsForUser(userId) {
  const rows = db
    .prepare(
      `select
        e.id,
        e.user_id,
        u.name as user_name,
        u.email as user_email,
        e.title,
        e.description,
        e.payload,
        e.status,
        e.created_at,
        e.approved_at,
        e.approved_by,
        a.name as approved_by_name
      from edits e
      join users u on u.id = e.user_id
      left join users a on a.id = e.approved_by
      where e.user_id = ?
      order by e.created_at desc, e.id desc`
    )
    .all(userId);
  return rows.map(serializeEditRow);
}

function listEditsForAdmin(status) {
  const normalizedStatus = normalizeStatus(status);
  const sqlBase = `
    select
      e.id,
      e.user_id,
      u.name as user_name,
      u.email as user_email,
      e.title,
      e.description,
      e.payload,
      e.status,
      e.created_at,
      e.approved_at,
      e.approved_by,
      a.name as approved_by_name
    from edits e
    join users u on u.id = e.user_id
    left join users a on a.id = e.approved_by
  `;
  const rows = normalizedStatus
    ? db
        .prepare(`${sqlBase} where e.status = ? order by e.created_at desc, e.id desc`)
        .all(normalizedStatus)
    : db.prepare(`${sqlBase} order by e.created_at desc, e.id desc`).all();
  return rows.map(serializeEditRow);
}

function validateSignInInput(body) {
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const errors = [];
  if (!email) errors.push("Email is required.");
  if (!password) errors.push("Password is required.");
  return { email, password, errors };
}

function validateCreateUserInput(body) {
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const errors = [];

  if (!name) errors.push("Name is required.");
  if (name.length > 120) errors.push("Name must be 120 characters or fewer.");
  if (!email) {
    errors.push("Email is required.");
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("Email format is invalid.");
  }
  if (!password) {
    errors.push("Password is required.");
  } else if (password.length < 8) {
    errors.push("Password must be at least 8 characters.");
  }

  return { name, email, password, errors };
}

function validateEditInput(body) {
  const title = String(body?.title || "").trim();
  const description = String(body?.description || "").trim();
  const payloadInput = body?.payload;
  const errors = [];

  if (!title) errors.push("Title is required.");
  if (!description) errors.push("Description is required.");
  if (title.length > 150) errors.push("Title must be 150 characters or fewer.");
  if (description.length > 5000) errors.push("Description must be 5000 characters or fewer.");

  let payload = {};
  if (payloadInput !== undefined && payloadInput !== null && String(payloadInput).trim() !== "") {
    if (typeof payloadInput === "object") {
      payload = payloadInput;
    } else {
      try {
        payload = JSON.parse(String(payloadInput));
      } catch {
        errors.push("Payload must be valid JSON.");
      }
    }
  }

  return { title, description, payload, errors };
}

app.get("/", (req, res) => {
  if (!req.user) {
    return res.redirect("/log");
  }
  if (req.user.role === "admin") {
    return res.redirect("/admin");
  }
  return res.redirect(`/panel/${req.user.slug}`);
});

app.get("/signin", (req, res) => {
  return res.redirect("/log");
});

app.get("/log", (req, res) => {
  if (req.user) {
    return res.redirect(req.user.role === "admin" ? "/admin" : `/panel/${req.user.slug}`);
  }
  return res.render("signin");
});

app.get("/create", (req, res) => {
  if (req.user) {
    return res.redirect(req.user.role === "admin" ? "/admin" : `/panel/${req.user.slug}`);
  }
  return res.render("create");
});

app.get("/panel/:slug", requireAuth, (req, res) => {
  const requestedSlug = String(req.params.slug || "").trim().toLowerCase();
  const panelUser = db
    .prepare("select id, name, email, role, slug from users where slug = ?")
    .get(requestedSlug);

  if (!panelUser) {
    return res.status(404).render("error", {
      title: "Panel not found",
      message: "No user panel exists for this URL.",
    });
  }

  if (req.user.role !== "admin" && req.user.slug !== requestedSlug) {
    return res.status(403).render("error", {
      title: "Access denied",
      message: "You can access only your own panel page.",
    });
  }

  return res.render("workspace", {
    panelUser,
    isAdmin: req.user.role === "admin",
    isOwnPanel: req.user.id === panelUser.id,
  });
});

app.get("/admin", requireAdmin, (req, res) => {
  return res.render("workspace", {
    panelUser: req.user,
    isAdmin: true,
    isOwnPanel: true,
  });
});

app.get("/admin/overview", requireAdmin, (req, res) => {
  const stats = db
    .prepare(
      `select
        (select count(*) from users) as total_users,
        (select count(*) from users where role = 'user') as total_regular_users,
        (select count(*) from edits) as total_edits,
        (select count(*) from edits where status = 'pending') as pending_edits`
    )
    .get();

  const recentUsers = db
    .prepare("select id, name, email, role, slug from users order by id desc limit 10")
    .all();
  const recentEdits = listEditsForAdmin(null).slice(0, 10);

  return res.render("admin-dashboard", {
    stats,
    recentUsers,
    recentEdits,
  });
});

app.get("/admin/users", requireAdmin, (req, res) => {
  const users = db
    .prepare(
      `select
        u.id,
        u.name,
        u.email,
        u.role,
        u.slug,
        sum(case when e.status = 'pending' then 1 else 0 end) as pending_edits,
        count(e.id) as total_edits
      from users u
      left join edits e on e.user_id = u.id
      group by u.id
      order by u.name collate nocase asc`
    )
    .all();

  return res.render("admin-users", { users });
});

app.get("/admin/users/:id", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).render("error", {
      title: "Invalid user id",
      message: "User id must be a positive integer.",
    });
  }

  const targetUser = db
    .prepare("select id, name, email, role, slug from users where id = ?")
    .get(userId);
  if (!targetUser) {
    return res.status(404).render("error", {
      title: "User not found",
      message: "This user does not exist.",
    });
  }

  const edits = listEditsForUser(userId);
  return res.render("admin-user-detail", { targetUser, edits });
});

app.get("/admin/edits", requireAdmin, (req, res) => {
  const filterStatus = normalizeStatus(req.query.status) || "all";
  const edits = filterStatus === "all" ? listEditsForAdmin(null) : listEditsForAdmin(filterStatus);
  return res.render("admin-edits", { edits, filterStatus });
});

app.post("/api/auth/signup", (req, res) => {
  const { name, email, password, errors } = validateCreateUserInput(req.body);
  if (errors.length) {
    return res.status(400).json({ error: errors.join(" ") });
  }

  let createdId;
  try {
    createdId = Number(
      createUser({
        name,
        email,
        password,
        role: "user",
      })
    );
  } catch (error) {
    if (error && error.code === "EMAIL_EXISTS") {
      return res.status(409).json({ error: "An account with this email already exists." });
    }
    throw error;
  }

  const user = db
    .prepare("select id, name, email, role, slug from users where id = ?")
    .get(createdId);

  const token = signSessionToken(user);
  setSessionCookie(res, token);

  return res.status(201).json({
    message: "Account created successfully.",
    user: buildSessionUser(user),
    redirect: `/panel/${user.slug}`,
  });
});

app.post("/api/auth/signin", (req, res) => {
  const { email, password, errors } = validateSignInInput(req.body);
  if (errors.length) {
    return res.status(400).json({ error: errors.join(" ") });
  }

  const user = db
    .prepare("select id, name, email, role, slug, password_hash from users where email = ?")
    .get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = signSessionToken(user);
  setSessionCookie(res, token);

  return res.json({
    message: "Signed in successfully.",
    user: buildSessionUser(user),
    redirect: user.role === "admin" ? "/admin" : `/panel/${user.slug}`,
  });
});

app.post("/api/auth/signout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ message: "Signed out." });
});

app.get("/api/me", requireAuth, (req, res) => {
  return res.json({ user: buildSessionUser(req.user) });
});

app.get("/api/content/current", requireAuth, (_req, res) => {
  return res.json({ state: getSiteState() });
});

app.put("/api/content/current", requireAdmin, (req, res) => {
  const incoming = req.body || {};
  const normalized = normalizeSiteState({
    sections: incoming.sections,
    products: incoming.products,
  });
  const saved = saveSiteState(normalized, req.user.id);
  return res.json({
    message: "Website content saved.",
    state: saved,
  });
});

app.get("/api/content/template", requireAuth, (_req, res) => {
  return res.json({
    template: {
      schema_version: "1.0",
      target: "full_website",
      sections: deepCloneJson(DEFAULT_SITE_STATE.sections),
      products: deepCloneJson(DEFAULT_SITE_STATE.products),
      notes: WEBSITE_EDIT_TEMPLATE.notes,
    },
  });
});

app.post("/api/edits", requireAuth, (req, res) => {
  if (req.user.role !== "user") {
    return res.status(403).json({ error: "Only regular users can submit edits." });
  }

  const { title, description, payload, errors } = validateEditInput(req.body);
  if (errors.length) {
    return res.status(400).json({ error: errors.join(" ") });
  }

  const info = db
    .prepare(
      `insert into edits (user_id, title, description, payload, status)
       values (?, ?, ?, ?, 'pending')`
    )
    .run(req.user.id, title, description, JSON.stringify(payload || {}));

  const created = getEditById(Number(info.lastInsertRowid));
  return res.status(201).json({
    message: "Edit submitted. Status is now Pending.",
    edit: created,
  });
});

app.get("/api/edits", requireAuth, (req, res) => {
  if (req.user.role === "admin") {
    return res.json({ edits: listEditsForAdmin(req.query.status) });
  }
  return res.json({ edits: listEditsForUser(req.user.id) });
});

function setEditDecision(decision) {
  return (req, res) => {
    const editId = Number(req.params.id);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: "Edit id must be a positive integer." });
    }

    const existing = getEditById(editId);
    if (!existing) {
      return res.status(404).json({ error: "Edit not found." });
    }

    db.prepare(
      `update edits
       set status = ?, approved_at = datetime('now'), approved_by = ?
       where id = ?`
    ).run(decision, req.user.id, editId);

    const updated = getEditById(editId);
    let message = decision === "approved" ? "Edit approved." : "Edit rejected.";
    if (decision === "approved") {
      const applied = applyPayloadToSiteState(updated.payload, req.user.id);
      if (applied) {
        message = "Edit approved and applied to website content.";
      } else {
        message = "Edit approved. No website content fields were found in payload.";
      }
    }
    return res.json({ message, edit: updated });
  };
}

app.patch("/api/edits/:id/approve", requireAdmin, setEditDecision("approved"));
app.patch("/api/edits/:id/reject", requireAdmin, setEditDecision("rejected"));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Route not found." });
  }
  return res.status(404).render("error", {
    title: "Not found",
    message: "The page you requested does not exist.",
  });
});

app.use((err, req, res, _next) => {
  // Keep error output explicit for debugging but avoid leaking internals in production.
  console.error(err);
  if (req.path.startsWith("/api/")) {
    return res.status(500).json({ error: "Internal server error." });
  }
  return res.status(500).render("error", {
    title: "Server error",
    message: "Unexpected error. Please try again.",
  });
});

app.listen(PORT, () => {
  console.log(`Auth admin app running at http://localhost:${PORT}`);
});
