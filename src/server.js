const fs = require("fs");
const path = require("path");
const vm = require("vm");
const passwordUtils = require("./password");
const express = require("express");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const { createUser, db } = require("./db");
const {
  attachCurrentUser,
  buildSessionUser,
  clearSessionCookie,
  requireAdmin,
  requireAdminOrVendor,
  requireAuth,
  requireUser,
  requireVendor,
  setSessionCookie,
  signSessionToken,
} = require("./auth");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SECTION_KEYS = ["home", "about", "services", "process", "gallery", "contact", "footer"];
const GALLERY_TYPES = new Set(["art", "designs", "books", "photography", "sculpture"]);
const PRODUCT_STATUSES = new Set(["active", "inactive", "draft"]);
const PRODUCT_SORT_FIELDS = new Set(["sort_order", "name", "gallery_type", "status", "created_at"]);

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

function makeDefaultServiceItems() {
  return [
    { icon: "Curation", title: "Art Curation", description: "Tailored artwork selection for residences, offices, and hospitality spaces." },
    { icon: "Sourcing", title: "Artwork Sourcing", description: "Source original works from trusted regional and international artists." },
    { icon: "Commissions", title: "Commissions", description: "Coordinate custom artwork commissions with clear scope and timelines." },
    { icon: "Framing", title: "Framing & Production", description: "Museum-grade framing, printing, and production support." },
    { icon: "Install", title: "Installation", description: "Professional delivery and on-site installation with care." },
    { icon: "Projects", title: "Project Management", description: "End-to-end management from concept through completion." },
    { icon: "Brand", title: "Brand Art Programs", description: "Develop visual language through curated art programs." },
    { icon: "Advisory", title: "Collection Advisory", description: "Build and grow collections with acquisition strategy support." },
    { icon: "Catalog", title: "Cataloging", description: "Structured cataloging and documentation for collections." },
    { icon: "Exhibitions", title: "Exhibitions", description: "Plan and execute exhibitions for public and private venues." },
    { icon: "Conservation", title: "Conservation", description: "Coordinate preventive care and conservation with specialists." },
    { icon: "Digital", title: "Digital Presentation", description: "Create digital stories and online presentation assets." },
  ];
}

function makeDefaultProcessSteps() {
  return [
    { kicker: "Step 1", title: "Discovery", description: "Understand goals, audience, and project constraints.", illustration: "Discover" },
    { kicker: "Step 2", title: "Concept", description: "Define direction, references, and curation approach.", illustration: "Concept" },
    { kicker: "Step 3", title: "Selection", description: "Shortlist works aligned with the approved concept.", illustration: "Select" },
    { kicker: "Step 4", title: "Budgeting", description: "Finalize scope, pricing, and timeline commitments.", illustration: "Budget" },
    { kicker: "Step 5", title: "Production", description: "Prepare framing, printing, and finishing requirements.", illustration: "Produce" },
    { kicker: "Step 6", title: "Logistics", description: "Plan packing, transport, and site readiness.", illustration: "Logistics" },
    { kicker: "Step 7", title: "Installation", description: "Install works safely with final quality checks.", illustration: "Install" },
    { kicker: "Step 8", title: "Handover", description: "Deliver documentation and post-installation support.", illustration: "Handover" },
  ];
}

function toOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapDesignCategory(category) {
  const key = String(category || "").trim().toLowerCase();
  if (key === "cabinet") return "Cabinets";
  if (key === "sideboard") return "Sideboards";
  if (key === "decor") return "Decor";
  return "All";
}

function extractArrayLiteral(source, variableName) {
  const marker = `let ${variableName} = [`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return null;

  let cursor = source.indexOf("[", markerIndex);
  if (cursor === -1) return null;

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && !inTemplate && char === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inTemplate && char === "\"") {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && char === "`") {
      inTemplate = !inTemplate;
      continue;
    }
    if (inSingle || inDouble || inTemplate) {
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(source.indexOf("[", markerIndex), cursor + 1);
      }
    }
  }
  return null;
}

function parseLegacyArray(source, variableName) {
  const literal = extractArrayLiteral(source, variableName);
  if (!literal) return [];
  try {
    const parsed = vm.runInNewContext(literal, Object.create(null), { timeout: 500 });
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadLegacyWebsiteProducts() {
  const indexPath = path.join(__dirname, "..", "index.html");
  if (!fs.existsSync(indexPath)) return [];

  let htmlSource = "";
  try {
    htmlSource = fs.readFileSync(indexPath, "utf8");
  } catch {
    return [];
  }

  const legacyDesigns = parseLegacyArray(htmlSource, "PRODUCTS");
  const legacyBooks = parseLegacyArray(htmlSource, "BOOKS");
  const legacyArt = parseLegacyArray(htmlSource, "ARTWORKS");
  const legacySculptures = parseLegacyArray(htmlSource, "SCULPTURES");

  if (!legacyDesigns.length && !legacyBooks.length && !legacyArt.length && !legacySculptures.length) {
    return [];
  }

  const mapped = [];
  let sortOrder = 1;

  legacyDesigns.forEach((item) => {
    const coords = Array.isArray(item?.store?.coords) ? item.store.coords : [];
    mapped.push({
      id: String(item?.id || `design-${sortOrder}`),
      name: String(item?.name || "Untitled Product"),
      gallery_type: "designs",
      category: mapDesignCategory(item?.category),
      status: "active",
      sort_order: sortOrder,
      artist_name: String(item?.artist?.name || ""),
      artist_role: String(item?.artist?.role || ""),
      artist_image_url: String(item?.artist?.img || ""),
      artist_bio: String(item?.artist?.bio || ""),
      image_url: String(item?.img || ""),
      media_images: Array.isArray(item?.images) ? item.images.map((value) => String(value || "").trim()).filter(Boolean) : [],
      model_url: String(item?.model || ""),
      theme: "",
      color: "",
      size: "",
      tag: "",
      kicker: "",
      material: String(item?.specs?.mat || ""),
      dimensions: String(item?.specs?.dim || ""),
      store_name: String(item?.store?.name || ""),
      store_lng: toOptionalNumber(coords[0]),
      store_lat: toOptionalNumber(coords[1]),
      medium: "",
      period: "",
      era: "",
      year: null,
      rating: null,
      rating_count: "",
      base_price: null,
      owner_user_id: null,
    });
    sortOrder += 1;
  });

  legacyBooks.forEach((item) => {
    mapped.push({
      id: String(item?.id || `book-${sortOrder}`),
      name: String(item?.name || "Untitled Product"),
      gallery_type: "books",
      category: "Books",
      status: "active",
      sort_order: sortOrder,
      artist_name: "",
      artist_role: "",
      artist_image_url: "",
      artist_bio: "",
      image_url: String(item?.img || ""),
      media_images: Array.isArray(item?.images) ? item.images.map((value) => String(value || "").trim()).filter(Boolean) : [],
      model_url: "",
      theme: String(item?.theme || ""),
      color: String(item?.color || ""),
      size: String(item?.size || ""),
      tag: String(item?.tag || ""),
      kicker: String(item?.kicker || ""),
      material: "",
      dimensions: "",
      store_name: "",
      store_lng: null,
      store_lat: null,
      medium: "",
      period: "",
      era: "",
      year: null,
      rating: null,
      rating_count: "",
      base_price: toOptionalNumber(item?.priceValue),
      owner_user_id: null,
    });
    sortOrder += 1;
  });

  legacyArt.forEach((item) => {
    mapped.push({
      id: String(item?.id || `art-${sortOrder}`),
      name: String(item?.name || "Untitled Product"),
      gallery_type: "art",
      category: "Artwork",
      status: "active",
      sort_order: sortOrder,
      artist_name: String(item?.artist || ""),
      artist_role: "",
      artist_image_url: "",
      artist_bio: "",
      image_url: String(item?.img || ""),
      media_images: Array.isArray(item?.images) ? item.images.map((value) => String(value || "").trim()).filter(Boolean) : [],
      model_url: String(item?.model || ""),
      theme: "",
      color: "",
      size: "",
      tag: "",
      kicker: "",
      material: String(item?.medium || ""),
      dimensions: "",
      store_name: "",
      store_lng: null,
      store_lat: null,
      medium: String(item?.medium || ""),
      period: String(item?.period || ""),
      era: "",
      year: toOptionalNumber(item?.year),
      rating: toOptionalNumber(item?.rating),
      rating_count: String(item?.ratingCount || ""),
      base_price: toOptionalNumber(item?.basePrice),
      owner_user_id: null,
    });
    sortOrder += 1;
  });

  legacySculptures.forEach((item) => {
    mapped.push({
      id: String(item?.id || `sculpture-${sortOrder}`),
      name: String(item?.name || "Untitled Product"),
      gallery_type: "sculpture",
      category: "Sculpture",
      status: "active",
      sort_order: sortOrder,
      artist_name: String(item?.artist || ""),
      artist_role: "",
      artist_image_url: "",
      artist_bio: "",
      image_url: String(item?.img || ""),
      media_images: Array.isArray(item?.images) ? item.images.map((value) => String(value || "").trim()).filter(Boolean) : [],
      model_url: String(item?.model || ""),
      theme: "",
      color: "",
      size: "",
      tag: "",
      kicker: "",
      material: String(item?.material || item?.medium || ""),
      dimensions: "",
      store_name: "",
      store_lng: null,
      store_lat: null,
      medium: String(item?.medium || item?.material || ""),
      period: String(item?.period || ""),
      era: String(item?.era || ""),
      year: toOptionalNumber(item?.year),
      rating: toOptionalNumber(item?.rating),
      rating_count: String(item?.ratingCount || ""),
      base_price: toOptionalNumber(item?.basePrice),
      owner_user_id: null,
    });
    sortOrder += 1;
  });

  return mapped;
}

const FALLBACK_BOOTSTRAP_PRODUCTS = [
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
    media_images: [],
    model_url: "",
    theme: "",
    color: "",
    size: "",
    tag: "",
    kicker: "",
    material: "Oil on canvas",
    dimensions: "12 x 16",
    store_name: "",
    store_lng: null,
    store_lat: null,
    medium: "Oil",
    period: "19th Century",
    era: "",
    year: 1890,
    rating: 4.8,
    rating_count: "50+",
    base_price: 153,
    owner_user_id: null,
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
    media_images: [],
    model_url: "",
    theme: "",
    color: "",
    size: "",
    tag: "",
    kicker: "",
    material: "Oak wood",
    dimensions: "180 x 45 x 95",
    store_name: "FNN Store",
    store_lng: null,
    store_lat: null,
    medium: "",
    period: "",
    era: "",
    year: null,
    rating: null,
    rating_count: "",
    base_price: null,
    owner_user_id: null,
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
    media_images: [],
    model_url: "",
    theme: "Heritage",
    color: "Warm",
    size: "Classic",
    tag: "",
    kicker: "",
    material: "",
    dimensions: "",
    store_name: "",
    store_lng: null,
    store_lat: null,
    medium: "",
    period: "",
    era: "",
    year: null,
    rating: null,
    rating_count: "",
    base_price: null,
    owner_user_id: null,
  },
];

function makeDefaultCatalogProducts() {
  const legacyProducts = loadLegacyWebsiteProducts();
  if (legacyProducts.length) return legacyProducts;
  return FALLBACK_BOOTSTRAP_PRODUCTS.map((product) => ({
    ...product,
    media_images: Array.isArray(product.media_images) ? product.media_images.slice() : [],
  }));
}

const AUTO_EXPAND_BOOTSTRAP_IDS = new Set(FALLBACK_BOOTSTRAP_PRODUCTS.map((product) => String(product.id)));
const AUTO_EXPAND_BOOTSTRAP_NAMES = new Set(
  FALLBACK_BOOTSTRAP_PRODUCTS.map((product) => String(product.name || "").trim().toLowerCase())
);
const DEFAULT_CATALOG_PRODUCTS = makeDefaultCatalogProducts();

const DEFAULT_SITE_STATE = Object.freeze({
  sections: {
    home: {
      welcome: "Welcome to",
      tagline: "The New Marketplace for Exceptional Art",
      banner_title: "Original Art For Sale",
      banner_button: "Browse Collection",
      slides: [{ image_url: "" }, { image_url: "" }, { image_url: "" }],
    },
    about: {
      title: "About FNN",
      lead: "FNN is a modern marketplace art platform specializing in the presentation of original artworks by selected artists.",
      sublead: "Its mission is to elevate art as a cultural value and creative identity by connecting artists with audiences and institutions.",
      cards: [
        { meta: "Curated", title: "Selected Artists", description: "We feature artists with clear voice and strong body of work.", image_url: "" },
        { meta: "Trusted", title: "Project Delivery", description: "From briefing to installation, projects are executed with precision.", image_url: "" },
        { meta: "Regional", title: "GCC Focus", description: "Building long-term cultural value across regional audiences.", image_url: "" },
      ],
    },
    services: {
      title: "Services",
      subtitle: "A complete pipeline from creative direction to installation.",
      items: makeDefaultServiceItems(),
    },
    process: {
      title: "Our Process",
      subtitle: "Eight clear steps from discovery to delivery.",
      steps: makeDefaultProcessSteps(),
    },
    gallery: {
      title: "Gallery",
      artists_button: "Artists",
      tabs: { art: "Art", designs: "Designs", books: "Books", photography: "Photography" },
      art_types: ["Artwork", "Sculpture"],
      design_filters: ["All", "Cabinets", "Sideboards", "Decor"],
      book_filters: {
        themes: ["Heritage", "Pilgrimage", "Architecture", "Travel", "Culture"],
        colors: ["Warm", "Cool", "Neutral", "Bold"],
        sizes: ["Compact", "Classic", "Large"],
      },
    },
    contact: {
      title: "Get in Touch",
      subtitle: "Interested in a piece? Let us know.",
      form_placeholders: {
        name: "Your Name",
        email: "Your Email",
        subject: "Subject",
        message: "Message...",
      },
      button: "Send Inquiry",
    },
    footer: {
      brand: "FNN ART",
      note: "A modern art platform specializing in original works by selected artists and connecting creative expression with audiences.",
      contact_title: "Contact us",
      contact: "anaskaroti@gmail.com",
      navigation_title: "Navigation",
      social_title: "Follow us",
      navigation: { home: "Home", about: "About", services: "Services", gallery: "Gallery", contact: "Contact" },
      social: ["@fnn", "@fnn", "@fnn", "@fnn"],
      copyright: "(c) 2025 FNN ART. All rights reserved.",
    },
  },
  products: DEFAULT_CATALOG_PRODUCTS
});

const WEBSITE_EDIT_TEMPLATE = Object.freeze({
  schema_version: "1.0",
  target: "full_website",
  sections: DEFAULT_SITE_STATE.sections,
  products: [
    {
      action: "create_or_update",
      id: "existing-product-id-or-empty-for-create",
      name: "",
      gallery_type: "art",
      status: "active",
      sort_order: 0,
      category: "",
      image_url: "",
      media_images: [],
      model_url: "",
      artist_name: "",
      artist_role: "",
      artist_image_url: "",
      artist_bio: "",
      theme: "",
      color: "",
      size: "",
      tag: "",
      kicker: "",
      material: "",
      dimensions: "",
      store_name: "",
      store_lng: null,
      store_lat: null,
      medium: "",
      period: "",
      era: "",
      year: null,
      rating: null,
      rating_count: "",
      base_price: null,
    },
  ],
  notes: "Admins can edit all site content. Vendors can submit product changes for approval.",
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

function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  if (Array.isArray(source)) {
    return source.map((item) => {
      if (item && typeof item === "object") {
        return deepMerge(Array.isArray(item) ? [] : {}, item);
      }
      return item;
    });
  }

  const next = Array.isArray(target) ? [] : { ...(target || {}) };
  Object.entries(source).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      next[key] = value.map((item) => {
        if (item && typeof item === "object") {
          return deepMerge(Array.isArray(item) ? [] : {}, item);
        }
        return item;
      });
      return;
    }
    if (value && typeof value === "object") {
      next[key] = deepMerge(next[key] || {}, value);
      return;
    }
    next[key] = value;
  });

  return next;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toGalleryType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "furniture") return "designs";
  if (GALLERY_TYPES.has(normalized)) return normalized;
  return "art";
}

function toProductStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (PRODUCT_STATUSES.has(normalized)) return normalized;
  return "active";
}

function parseMediaImages(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeProduct(product, index = 0) {
  const p = (product && typeof product === "object") ? product : {};
  const galleryType = toGalleryType(p.gallery_type);
  const defaultCategory = galleryType === "art"
    ? "Artwork"
    : galleryType === "sculpture"
      ? "Sculpture"
      : "All";
  const now = new Date().toISOString();

  return {
    id: String(p.id || `prod-${Date.now()}-${index}`),
    name: String(p.name || "Untitled Product"),
    gallery_type: galleryType,
    category: String(p.category || defaultCategory),
    status: toProductStatus(p.status),
    sort_order: Number.isFinite(Number(p.sort_order)) ? Number(p.sort_order) : 0,
    artist_name: String(p.artist_name || ""),
    artist_role: String(p.artist_role || ""),
    artist_image_url: String(p.artist_image_url || ""),
    artist_bio: String(p.artist_bio || ""),
    image_url: String(p.image_url || ""),
    media_images: parseMediaImages(p.media_images),
    model_url: String(p.model_url || ""),
    theme: String(p.theme || ""),
    color: String(p.color || ""),
    size: String(p.size || ""),
    tag: String(p.tag || ""),
    kicker: String(p.kicker || ""),
    material: String(p.material || ""),
    dimensions: String(p.dimensions || ""),
    store_name: String(p.store_name || ""),
    store_lng: toNumberOrNull(p.store_lng),
    store_lat: toNumberOrNull(p.store_lat),
    medium: String(p.medium || ""),
    period: String(p.period || ""),
    era: String(p.era || ""),
    year: toNumberOrNull(p.year),
    rating: toNumberOrNull(p.rating),
    rating_count: String(p.rating_count || ""),
    base_price: toNumberOrNull(p.base_price),
    owner_user_id: toNumberOrNull(p.owner_user_id),
    created_at: String(p.created_at || now),
    updated_at: String(p.updated_at || now),
  };
}

function normalizeSections(inputSections) {
  const defaults = deepCloneJson(DEFAULT_SITE_STATE.sections);
  if (!inputSections || typeof inputSections !== "object" || Array.isArray(inputSections)) {
    return defaults;
  }
  const merged = deepMerge(defaults, inputSections);
  SECTION_KEYS.forEach((key) => {
    if (!merged[key] || typeof merged[key] !== "object" || Array.isArray(merged[key])) {
      merged[key] = defaults[key];
    }
  });
  return merged;
}

function normalizeSiteState(input) {
  const base = deepCloneJson(DEFAULT_SITE_STATE);
  if (!input || typeof input !== "object") {
    return base;
  }

  if (input.sections && typeof input.sections === "object" && !Array.isArray(input.sections)) {
    base.sections = normalizeSections(input.sections);
  }

  if (Array.isArray(input.products)) {
    base.products = input.products.map((product, index) => normalizeProduct(product, index));
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

  const normalized = normalizeSiteState({
    sections: safeJsonParseText(row.sections_json, deepCloneJson(DEFAULT_SITE_STATE.sections)),
    products: safeJsonParseText(row.products_json, deepCloneJson(DEFAULT_SITE_STATE.products)),
  });

  const hasOnlyBootstrapSeed =
    Array.isArray(normalized.products) &&
    normalized.products.length > 0 &&
    normalized.products.length <= AUTO_EXPAND_BOOTSTRAP_IDS.size &&
    normalized.products.every((product) =>
      AUTO_EXPAND_BOOTSTRAP_IDS.has(String(product.id)) ||
      AUTO_EXPAND_BOOTSTRAP_NAMES.has(String(product.name || "").trim().toLowerCase())
    );

  if (
    !Array.isArray(normalized.products) ||
    normalized.products.length === 0 ||
    hasOnlyBootstrapSeed
  ) {
    normalized.products = deepCloneJson(DEFAULT_SITE_STATE.products).map((product, index) =>
      normalizeProduct(product, index)
    );
    db.prepare(
      `update site_state
       set sections_json = ?, products_json = ?, updated_at = datetime('now'), updated_by = null
       where id = 1`
    ).run(JSON.stringify(normalized.sections), JSON.stringify(normalized.products));
  }

  return normalized;
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

function saveSection(sectionKey, content, updatedBy) {
  if (!SECTION_KEYS.includes(sectionKey)) {
    const err = new Error("Unknown section key.");
    err.statusCode = 400;
    throw err;
  }
  const current = getSiteState();
  const nextSections = normalizeSections({ [sectionKey]: content });
  current.sections[sectionKey] = nextSections[sectionKey];
  return saveSiteState(current, updatedBy);
}

function getProductsArray() {
  const state = getSiteState();
  return Array.isArray(state.products)
    ? state.products.map((product, index) => normalizeProduct(product, index))
    : [];
}

function findProductById(productId) {
  const key = String(productId || "").trim();
  if (!key) return null;
  return getProductsArray().find((product) => String(product.id) === key) || null;
}

function isPublicProduct(product) {
  return String(product?.status || "").toLowerCase() === "active";
}

function canActorReadProduct(actor, product) {
  if (!product) return false;
  if (!actor || actor.role === "user") return isPublicProduct(product);
  if (actor.role === "admin") return true;
  if (actor.role === "vendor") {
    return Number(product.owner_user_id) === Number(actor.id);
  }
  return false;
}

function compareProducts(a, b, sortBy, sortDir) {
  const factor = sortDir === "desc" ? -1 : 1;
  if (sortBy === "sort_order") {
    const numA = Number(a.sort_order || 0);
    const numB = Number(b.sort_order || 0);
    if (numA === numB) return String(a.name || "").localeCompare(String(b.name || "")) * factor;
    return (numA - numB) * factor;
  }
  if (sortBy === "created_at") {
    const timeA = Date.parse(String(a.created_at || ""));
    const timeB = Date.parse(String(b.created_at || ""));
    const safeA = Number.isFinite(timeA) ? timeA : 0;
    const safeB = Number.isFinite(timeB) ? timeB : 0;
    if (safeA === safeB) return String(a.name || "").localeCompare(String(b.name || "")) * factor;
    return (safeA - safeB) * factor;
  }
  const textA = String(a[sortBy] || "").toLowerCase();
  const textB = String(b[sortBy] || "").toLowerCase();
  if (textA === textB) return String(a.name || "").localeCompare(String(b.name || "")) * factor;
  return textA.localeCompare(textB) * factor;
}

function listProductsWithQuery({ actor, query = {} }) {
  const rawPage = Number(query.page || 1);
  const rawPageSizeInput = query.page_size ?? query.pageSize ?? 24;
  const rawPageSize = String(rawPageSizeInput).toLowerCase() === "all" ? 10000 : Number(rawPageSizeInput);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(200, Math.floor(rawPageSize)) : 24;
  const search = String(query.search || "").trim().toLowerCase();
  const galleryType = String(query.gallery_type || query.galleryType || "").trim().toLowerCase();
  const status = String(query.status || "").trim().toLowerCase();
  const sortByRaw = String(query.sort_by || query.sortBy || "sort_order").trim().toLowerCase();
  const sortBy = PRODUCT_SORT_FIELDS.has(sortByRaw) ? sortByRaw : "sort_order";
  const sortDir = String(query.sort_dir || query.sortDir || "asc").trim().toLowerCase() === "desc" ? "desc" : "asc";

  let rows = getProductsArray();
  if (!actor || actor.role === "user") {
    rows = rows.filter((product) => isPublicProduct(product));
  } else if (actor.role === "vendor") {
    rows = rows.filter((product) => Number(product.owner_user_id) === Number(actor.id));
  }

  if (search) {
    rows = rows.filter((product) => {
      const haystack = [
        product.id,
        product.name,
        product.gallery_type,
        product.category,
        product.artist_name,
        product.artist_role,
      ].map((item) => String(item || "").toLowerCase());
      return haystack.some((item) => item.includes(search));
    });
  }

  if (galleryType) {
    const normalizedType = toGalleryType(galleryType);
    if (normalizedType === "art") {
      rows = rows.filter((product) => ["art", "sculpture"].includes(String(product.gallery_type).toLowerCase()));
    } else {
      rows = rows.filter((product) => String(product.gallery_type).toLowerCase() === normalizedType);
    }
  }

  if (status && PRODUCT_STATUSES.has(status)) {
    rows = rows.filter((product) => String(product.status || "").toLowerCase() === status);
  }

  const sorted = rows.slice().sort((a, b) => compareProducts(a, b, sortBy, sortDir));
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const normalizedPage = Math.min(page, totalPages);
  const start = (normalizedPage - 1) * pageSize;
  const items = sorted.slice(start, start + pageSize);

  return {
    items,
    total,
    page: normalizedPage,
    pageSize,
    totalPages,
    hasPrev: normalizedPage > 1,
    hasNext: normalizedPage < totalPages,
    sortBy,
    sortDir,
    filters: {
      search,
      galleryType,
      status,
    },
  };
}

function getProductLikeCounts(productIds) {
  if (!Array.isArray(productIds) || !productIds.length) return {};
  const placeholders = productIds.map(() => "?").join(",");
  const rows = db.prepare(
    `select product_id, count(*) as total
     from likes
     where product_id in (${placeholders})
     group by product_id`
  ).all(...productIds.map((id) => String(id)));
  const map = {};
  rows.forEach((row) => {
    map[String(row.product_id)] = Number(row.total || 0);
  });
  return map;
}

function hasUserLikedProduct(userId, productId) {
  const row = db
    .prepare("select 1 from likes where user_id = ? and product_id = ?")
    .get(Number(userId), String(productId));
  return !!row;
}

function getUserLikedProductIds(userId) {
  const rows = db.prepare("select product_id from likes where user_id = ?").all(Number(userId));
  return new Set(rows.map((row) => String(row.product_id)));
}

function listProductComments(productId, limit = 100) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  return db.prepare(
    `select
      c.id,
      c.user_id as userId,
      u.name as userName,
      c.product_id as productId,
      c.content,
      c.created_at as createdAt,
      c.updated_at as updatedAt
    from comments c
    join users u on u.id = c.user_id
    where c.product_id = ?
    order by c.created_at desc, c.id desc
    limit ?`
  ).all(String(productId), safeLimit);
}

function sanitizeCommentContent(rawContent) {
  const content = String(rawContent || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!content) {
    const err = new Error("Comment cannot be empty.");
    err.statusCode = 400;
    throw err;
  }
  if (content.length > 1200) {
    const err = new Error("Comment must be 1200 characters or fewer.");
    err.statusCode = 400;
    throw err;
  }
  return content;
}

function enforceCommentRateLimit(userId) {
  const latest = db
    .prepare("select created_at from comments where user_id = ? order by id desc limit 1")
    .get(Number(userId));
  if (!latest || !latest.created_at) return;
  const latestTime = Date.parse(String(latest.created_at).replace(" ", "T") + "Z");
  if (!Number.isFinite(latestTime)) return;
  if (Date.now() - latestTime < 5000) {
    const err = new Error("Please wait a few seconds before posting another comment.");
    err.statusCode = 429;
    throw err;
  }
}

function listUserCart(userId) {
  return db.prepare(
    `select
      ci.product_id as productId,
      ci.quantity,
      ci.updated_at as updatedAt
    from cart_items ci
    where ci.user_id = ?
    order by ci.updated_at desc`
  ).all(Number(userId));
}

function serializeCart(userId) {
  const products = getProductsArray();
  const byId = new Map(products.map((product) => [String(product.id), product]));
  const items = listUserCart(userId).map((item) => ({
    ...item,
    product: byId.get(String(item.productId)) || null,
  }));
  return {
    items,
    totalItems: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
    uniqueItems: items.length,
  };
}

function mergeProductChanges(currentProducts, productChanges) {
  const baseProducts = Array.isArray(currentProducts)
    ? currentProducts.map((product, index) => normalizeProduct(product, index))
    : [];
  const normalizedChanges = Array.isArray(productChanges)
    ? productChanges.map((product, index) => normalizeProduct(product, index))
    : [];
  const productMap = new Map(baseProducts.map((product) => [String(product.id), product]));

  normalizedChanges.forEach((incoming) => {
    const key = String(incoming.id);
    const existing = productMap.get(key);
    const now = new Date().toISOString();
    if (existing) {
      productMap.set(key, {
        ...existing,
        ...incoming,
        created_at: existing.created_at || now,
        updated_at: now,
        owner_user_id:
          incoming.owner_user_id !== null && incoming.owner_user_id !== undefined
            ? incoming.owner_user_id
            : (existing.owner_user_id ?? null),
      });
      return;
    }
    productMap.set(key, {
      ...incoming,
      created_at: incoming.created_at || now,
      updated_at: now,
    });
  });

  return Array.from(productMap.values()).sort((a, b) => compareProducts(a, b, "sort_order", "asc"));
}

function buildVendorProductPayload(rawPayload, userId) {
  const payload = (rawPayload && typeof rawPayload === "object") ? rawPayload : {};
  if (payload.sections) {
    const err = new Error("Vendors can edit products only.");
    err.statusCode = 403;
    throw err;
  }

  const changes = Array.isArray(payload.product_changes)
    ? payload.product_changes
    : (Array.isArray(payload.products) ? payload.products : (payload.product ? [payload.product] : []));
  if (!changes.length) {
    const err = new Error("Please provide at least one product change.");
    err.statusCode = 400;
    throw err;
  }

  const current = getSiteState();
  const currentMap = new Map((current.products || []).map((product) => [String(product.id), product]));
  const normalizedChanges = changes.map((product, index) => normalizeProduct(product, index)).map((product) => {
    const existing = currentMap.get(String(product.id));
    if (existing && Number(existing.owner_user_id) !== Number(userId)) {
      const err = new Error("You can edit only your own products.");
      err.statusCode = 403;
      throw err;
    }
    return {
      ...product,
      owner_user_id: Number(userId),
    };
  });

  return {
    target: "vendor_products",
    product_changes: normalizedChanges,
  };
}

function applyPayloadToSiteState(payload, adminUserId) {
  if (!payload || typeof payload !== "object") return false;

  const current = getSiteState();
  const next = deepCloneJson(current);
  let changed = false;

  if (payload.sections && typeof payload.sections === "object" && !Array.isArray(payload.sections)) {
    next.sections = normalizeSections(payload.sections);
    changed = true;
  }

  if (Array.isArray(payload.products)) {
    next.products = payload.products.map((product, index) => normalizeProduct(product, index));
    changed = true;
  }

  if (Array.isArray(payload.product_changes)) {
    next.products = mergeProductChanges(next.products, payload.product_changes);
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
    return res.redirect("/products");
  }
  if (req.user.role === "admin") {
    return res.redirect("/admin");
  }
  if (req.user.role === "vendor") {
    return res.redirect(`/panel/${req.user.slug}`);
  }
  return res.redirect("/user/panel");
});

app.get("/signin", (req, res) => {
  return res.redirect("/log");
});

app.get("/log", (req, res) => {
  if (req.user) {
    if (req.user.role === "admin") return res.redirect("/admin");
    if (req.user.role === "vendor") return res.redirect(`/panel/${req.user.slug}`);
    return res.redirect("/user/panel");
  }
  return res.render("signin", { mode: "vendor" });
});

app.get("/create", (req, res) => {
  if (req.user) {
    if (req.user.role === "admin") return res.redirect("/admin");
    if (req.user.role === "vendor") return res.redirect(`/panel/${req.user.slug}`);
    return res.redirect("/user/panel");
  }
  return res.render("create", { mode: "vendor" });
});

app.get("/user/log", (req, res) => {
  if (req.user) {
    if (req.user.role === "user") return res.redirect("/user/panel");
    if (req.user.role === "admin") return res.redirect("/admin");
    return res.redirect(`/panel/${req.user.slug}`);
  }
  return res.render("user-signin");
});

app.get("/user/create", (req, res) => {
  if (req.user) {
    if (req.user.role === "user") return res.redirect("/user/panel");
    if (req.user.role === "admin") return res.redirect("/admin");
    return res.redirect(`/panel/${req.user.slug}`);
  }
  return res.render("user-create");
});

app.get("/panel/:slug", requireAdminOrVendor, (req, res) => {
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
      message: "You can access only your own vendor panel page.",
    });
  }

  if (req.user.role !== "admin" && panelUser.role !== "vendor") {
    return res.status(403).render("error", {
      title: "Access denied",
      message: "Vendor panel is available only for vendor accounts.",
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

app.get("/user/panel", requireUser, (req, res) => {
  return res.render("user-panel", { panelUser: req.user });
});

app.get("/products", (req, res) => {
  const listing = listProductsWithQuery({
    actor: req.user,
    query: {
      page: req.query.page,
      page_size: req.query.page_size || req.query.pageSize || 24,
      search: req.query.search,
      gallery_type: req.query.gallery_type || req.query.galleryType,
      sort_by: req.query.sort_by || req.query.sortBy || "sort_order",
      sort_dir: req.query.sort_dir || req.query.sortDir || "asc",
    },
  });

  const productIds = listing.items.map((item) => item.id);
  const likeCounts = getProductLikeCounts(productIds);
  const likedSet = req.user && req.user.role === "user"
    ? getUserLikedProductIds(req.user.id)
    : new Set();

  const products = listing.items.map((product) => ({
    ...product,
    likesCount: likeCounts[String(product.id)] || 0,
    likedByMe: likedSet.has(String(product.id)),
  }));

  return res.render("products", {
    products,
    paging: listing,
    query: req.query || {},
    currentUser: req.user || null,
  });
});

app.get("/products/:id", (req, res) => {
  const productId = String(req.params.id || "").trim();
  const product = findProductById(productId);
  if (!product || !canActorReadProduct(req.user || null, product)) {
    return res.status(404).render("error", {
      title: "Product not found",
      message: "This product does not exist.",
    });
  }

  const likesCount = getProductLikeCounts([product.id])[String(product.id)] || 0;
  const likedByMe = req.user && req.user.role === "user"
    ? hasUserLikedProduct(req.user.id, product.id)
    : false;
  const comments = listProductComments(product.id, 100);

  return res.render("product-detail", {
    product,
    comments,
    likesCount,
    likedByMe,
    currentUser: req.user || null,
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
        role: "vendor",
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
    message: "Vendor account created successfully.",
    user: buildSessionUser(user),
    redirect: `/panel/${user.slug}`,
  });
});

app.post("/api/auth/signin", (req, res) => {
  const { email, password: plainPassword, errors } = validateSignInInput(req.body);
  if (errors.length) {
    return res.status(400).json({ error: errors.join(" ") });
  }

  const user = db
    .prepare("select id, name, email, role, slug, password_hash from users where email = ?")
    .get(email);
  if (!user || !passwordUtils.compareSync(plainPassword, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  if (user.role === "user") {
    return res.status(403).json({ error: "Use the User login page for this account." });
  }

  const token = signSessionToken(user);
  setSessionCookie(res, token);

  return res.json({
    message: "Signed in successfully.",
    user: buildSessionUser(user),
    redirect: user.role === "admin" ? "/admin" : `/panel/${user.slug}`,
  });
});

app.post("/api/auth/user/signup", (req, res) => {
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
    message: "User account created successfully.",
    user: buildSessionUser(user),
    redirect: "/user/panel",
  });
});

app.post("/api/auth/user/signin", (req, res) => {
  const { email, password: plainPassword, errors } = validateSignInInput(req.body);
  if (errors.length) {
    return res.status(400).json({ error: errors.join(" ") });
  }

  const user = db
    .prepare("select id, name, email, role, slug, password_hash from users where email = ?")
    .get(email);
  if (!user || !passwordUtils.compareSync(plainPassword, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  if (user.role !== "user") {
    return res.status(403).json({ error: "This account is not a standard user account." });
  }

  const token = signSessionToken(user);
  setSessionCookie(res, token);

  return res.json({
    message: "Signed in successfully.",
    user: buildSessionUser(user),
    redirect: "/user/panel",
  });
});

app.post("/api/auth/signout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ message: "Signed out." });
});

app.get("/api/me", requireAuth, (req, res) => {
  return res.json({ user: buildSessionUser(req.user) });
});

app.get("/api/public/content", (req, res) => {
  const state = getSiteState();
  return res.json({ sections: state.sections });
});

app.get("/api/content/current", requireAdminOrVendor, (req, res) => {
  const state = getSiteState();
  if (req.user.role === "admin") {
    return res.json({ state });
  }

  const vendorProducts = (state.products || []).filter(
    (product) => Number(product.owner_user_id) === Number(req.user.id)
  );
  return res.json({
    state: {
      sections: {},
      products: vendorProducts,
    },
  });
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

app.put("/api/content/sections/:sectionKey", requireAdmin, (req, res) => {
  const sectionKey = String(req.params.sectionKey || "").trim().toLowerCase();
  if (!SECTION_KEYS.includes(sectionKey)) {
    return res.status(400).json({ error: "Unknown section key." });
  }
  const content = req.body?.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return res.status(400).json({ error: "Section content must be an object." });
  }
  const saved = saveSection(sectionKey, content, req.user.id);
  return res.json({
    message: "Section saved.",
    sectionKey,
    content: saved.sections[sectionKey],
  });
});

app.get("/api/content/template", requireAdminOrVendor, (req, res) => {
  if (req.user.role === "admin") {
    return res.json({
      template: {
        schema_version: "1.0",
        target: "full_website",
        sections: deepCloneJson(DEFAULT_SITE_STATE.sections),
        products: deepCloneJson(DEFAULT_SITE_STATE.products),
        notes: WEBSITE_EDIT_TEMPLATE.notes,
      },
    });
  }

  return res.json({
    template: {
      schema_version: "1.0",
      target: "vendor_products",
      sections: {},
      products: [],
      notes: "Vendors can add products and edit only their own products.",
    },
  });
});

app.get("/api/products", (req, res) => {
  const result = listProductsWithQuery({
    actor: req.user || null,
    query: req.query || {},
  });
  const productIds = result.items.map((item) => item.id);
  const likeCounts = getProductLikeCounts(productIds);
  const likedSet = req.user && req.user.role === "user"
    ? getUserLikedProductIds(req.user.id)
    : new Set();

  const items = result.items.map((item) => ({
    ...item,
    likesCount: likeCounts[String(item.id)] || 0,
    likedByMe: likedSet.has(String(item.id)),
  }));

  return res.json({
    items,
    paging: {
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
      hasPrev: result.hasPrev,
      hasNext: result.hasNext,
    },
    sort: {
      sortBy: result.sortBy,
      sortDir: result.sortDir,
    },
    filters: result.filters,
  });
});

app.get("/api/products/:id", (req, res) => {
  const productId = String(req.params.id || "").trim();
  const product = findProductById(productId);
  if (!product || !canActorReadProduct(req.user || null, product)) {
    return res.status(404).json({ error: "Product not found." });
  }

  const likesCount = getProductLikeCounts([product.id])[String(product.id)] || 0;
  const likedByMe = req.user && req.user.role === "user"
    ? hasUserLikedProduct(req.user.id, product.id)
    : false;
  return res.json({
    product,
    social: { likesCount, likedByMe },
  });
});

app.post("/api/products", requireAdmin, (req, res) => {
  const payload = (req.body?.product && typeof req.body.product === "object")
    ? req.body.product
    : req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "Product payload is required." });
  }

  const state = getSiteState();
  const product = normalizeProduct({ ...payload, id: payload.id || `prod-${Date.now()}` });
  state.products = mergeProductChanges(state.products, [product]);
  const saved = saveSiteState(state, req.user.id);
  const created = saved.products.find((item) => String(item.id) === String(product.id));
  return res.status(201).json({
    message: "Product created.",
    product: created || product,
  });
});

app.patch("/api/products/:id", requireAdmin, (req, res) => {
  const productId = String(req.params.id || "").trim();
  const state = getSiteState();
  const existing = (state.products || []).find((item) => String(item.id) === productId);
  if (!existing) {
    return res.status(404).json({ error: "Product not found." });
  }

  const payload = (req.body?.product && typeof req.body.product === "object")
    ? req.body.product
    : req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "Product payload is required." });
  }

  const merged = normalizeProduct({ ...existing, ...payload, id: productId });
  state.products = mergeProductChanges(state.products, [merged]);
  const saved = saveSiteState(state, req.user.id);
  const updated = saved.products.find((item) => String(item.id) === productId);
  return res.json({
    message: "Product updated.",
    product: updated || merged,
  });
});

app.delete("/api/products/:id", requireAdmin, (req, res) => {
  const productId = String(req.params.id || "").trim();
  const state = getSiteState();
  const beforeCount = (state.products || []).length;
  state.products = (state.products || []).filter((item) => String(item.id) !== productId);
  if (state.products.length === beforeCount) {
    return res.status(404).json({ error: "Product not found." });
  }
  saveSiteState(state, req.user.id);
  return res.json({ message: "Product deleted." });
});

app.post("/api/edits", requireVendor, (req, res) => {
  const { title, description, payload, errors } = validateEditInput(req.body);
  if (errors.length) {
    return res.status(400).json({ error: errors.join(" ") });
  }

  let payloadToSave = payload || {};
  try {
    payloadToSave = buildVendorProductPayload(payloadToSave, req.user.id);
  } catch (error) {
    const statusCode = Number(error && error.statusCode) || 400;
    return res.status(statusCode).json({ error: error.message || "Invalid vendor payload." });
  }

  const info = db
    .prepare(
      `insert into edits (user_id, title, description, payload, status)
       values (?, ?, ?, ?, 'pending')`
    )
    .run(req.user.id, title, description, JSON.stringify(payloadToSave));

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
  if (req.user.role === "user") {
    return res.json({ edits: [] });
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
    if (existing.status !== "pending") {
      return res.status(409).json({ error: "Only pending edits can be reviewed." });
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
        message = "Edit approved and applied to live content.";
      } else {
        message = "Edit approved. No applicable content payload found.";
      }
    }
    return res.json({ message, edit: updated });
  };
}

app.patch("/api/edits/:id/approve", requireAdmin, setEditDecision("approved"));
app.patch("/api/edits/:id/reject", requireAdmin, setEditDecision("rejected"));

app.post("/api/products/:id/like", requireUser, (req, res) => {
  const productId = String(req.params.id || "").trim();
  const product = findProductById(productId);
  if (!product || !isPublicProduct(product)) {
    return res.status(404).json({ error: "Product not found." });
  }

  const existing = db
    .prepare("select 1 from likes where user_id = ? and product_id = ?")
    .get(req.user.id, productId);
  let liked = false;
  if (existing) {
    db.prepare("delete from likes where user_id = ? and product_id = ?")
      .run(req.user.id, productId);
  } else {
    db.prepare("insert into likes (user_id, product_id) values (?, ?)")
      .run(req.user.id, productId);
    liked = true;
  }
  const likesCount = getProductLikeCounts([productId])[productId] || 0;
  return res.json({ liked, likesCount });
});

app.get("/api/products/:id/comments", (req, res) => {
  const productId = String(req.params.id || "").trim();
  const product = findProductById(productId);
  if (!product || !canActorReadProduct(req.user || null, product)) {
    return res.status(404).json({ error: "Product not found." });
  }
  return res.json({
    comments: listProductComments(productId, req.query.limit || 100),
  });
});

app.post("/api/products/:id/comments", requireUser, (req, res) => {
  const productId = String(req.params.id || "").trim();
  const product = findProductById(productId);
  if (!product || !isPublicProduct(product)) {
    return res.status(404).json({ error: "Product not found." });
  }

  let content;
  try {
    enforceCommentRateLimit(req.user.id);
    content = sanitizeCommentContent(req.body?.content);
  } catch (error) {
    return res.status(Number(error.statusCode) || 400).json({ error: error.message || "Invalid comment." });
  }

  const info = db.prepare(
    `insert into comments (user_id, product_id, content, created_at, updated_at)
     values (?, ?, ?, datetime('now'), datetime('now'))`
  ).run(req.user.id, productId, content);

  const comment = db.prepare(
    `select
      c.id,
      c.user_id as userId,
      u.name as userName,
      c.product_id as productId,
      c.content,
      c.created_at as createdAt,
      c.updated_at as updatedAt
    from comments c
    join users u on u.id = c.user_id
    where c.id = ?`
  ).get(Number(info.lastInsertRowid));

  return res.status(201).json({
    message: "Comment posted.",
    comment,
  });
});

app.get("/api/cart", requireUser, (req, res) => {
  return res.json({ cart: serializeCart(req.user.id) });
});

app.post("/api/cart/items", requireUser, (req, res) => {
  const productId = String(req.body?.productId || "").trim();
  const quantityRaw = Number(req.body?.quantity ?? 1);
  const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.floor(quantityRaw) : 1;
  const product = findProductById(productId);
  if (!product || !isPublicProduct(product)) {
    return res.status(404).json({ error: "Product not found." });
  }

  const existing = db
    .prepare("select quantity from cart_items where user_id = ? and product_id = ?")
    .get(req.user.id, productId);
  const nextQuantity = Number(existing?.quantity || 0) + quantity;
  db.prepare(
    `insert into cart_items (user_id, product_id, quantity, created_at, updated_at)
     values (?, ?, ?, datetime('now'), datetime('now'))
     on conflict(user_id, product_id) do update set
       quantity = excluded.quantity,
       updated_at = datetime('now')`
  ).run(req.user.id, productId, nextQuantity);

  return res.status(201).json({
    message: "Cart updated.",
    cart: serializeCart(req.user.id),
  });
});

app.patch("/api/cart/items/:productId", requireUser, (req, res) => {
  const productId = String(req.params.productId || "").trim();
  const quantity = Number(req.body?.quantity);
  if (!Number.isFinite(quantity)) {
    return res.status(400).json({ error: "Quantity must be a number." });
  }
  if (quantity <= 0) {
    db.prepare("delete from cart_items where user_id = ? and product_id = ?")
      .run(req.user.id, productId);
    return res.json({
      message: "Item removed from cart.",
      cart: serializeCart(req.user.id),
    });
  }

  const product = findProductById(productId);
  if (!product || !isPublicProduct(product)) {
    return res.status(404).json({ error: "Product not found." });
  }

  db.prepare(
    `insert into cart_items (user_id, product_id, quantity, created_at, updated_at)
     values (?, ?, ?, datetime('now'), datetime('now'))
     on conflict(user_id, product_id) do update set
       quantity = excluded.quantity,
       updated_at = datetime('now')`
  ).run(req.user.id, productId, Math.floor(quantity));

  return res.json({
    message: "Cart updated.",
    cart: serializeCart(req.user.id),
  });
});

app.delete("/api/cart/items/:productId", requireUser, (req, res) => {
  const productId = String(req.params.productId || "").trim();
  db.prepare("delete from cart_items where user_id = ? and product_id = ?")
    .run(req.user.id, productId);
  return res.json({
    message: "Item removed.",
    cart: serializeCart(req.user.id),
  });
});

app.delete("/api/cart", requireUser, (req, res) => {
  db.prepare("delete from cart_items where user_id = ?").run(req.user.id);
  return res.json({
    message: "Cart cleared.",
    cart: serializeCart(req.user.id),
  });
});

app.get("/api/user/dashboard", requireUser, (req, res) => {
  const likedRows = db.prepare(
    `select product_id as productId, created_at as createdAt
     from likes
     where user_id = ?
     order by created_at desc`
  ).all(req.user.id);
  const products = getProductsArray();
  const byId = new Map(products.map((product) => [String(product.id), product]));
  const likedProducts = likedRows
    .map((row) => ({
      ...row,
      product: byId.get(String(row.productId)) || null,
    }))
    .filter((item) => item.product && isPublicProduct(item.product));

  const comments = db.prepare(
    `select
      id,
      product_id as productId,
      content,
      created_at as createdAt
    from comments
    where user_id = ?
    order by created_at desc
    limit 100`
  ).all(req.user.id).map((item) => ({
    ...item,
    product: byId.get(String(item.productId)) || null,
  }));

  return res.json({
    likedProducts,
    comments,
    cart: serializeCart(req.user.id),
  });
});

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
  const statusCode = Number(err?.statusCode) || 500;
  if (req.path.startsWith("/api/")) {
    return res.status(statusCode).json({
      error: statusCode >= 500 ? "Internal server error." : (err.message || "Request failed."),
    });
  }
  return res.status(statusCode).render("error", {
    title: statusCode >= 500 ? "Server error" : "Request failed",
    message: statusCode >= 500 ? "Unexpected error. Please try again." : (err.message || "Request failed."),
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Auth admin app running at http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  getSiteState,
  saveSiteState,
  listProductsWithQuery,
};
