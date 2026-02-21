const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
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
const ACCOUNT_STATUSES = new Set(["active", "disabled"]);

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

const PRODUCT_NORMALIZED_FIELDS = new Set([
  "id",
  "name",
  "gallery_type",
  "category",
  "status",
  "sort_order",
  "artist_name",
  "artist_role",
  "artist_image_url",
  "artist_bio",
  "image_url",
  "media_images",
  "model_url",
  "theme",
  "color",
  "size",
  "tag",
  "kicker",
  "material",
  "dimensions",
  "store_name",
  "store_lng",
  "store_lat",
  "medium",
  "period",
  "era",
  "year",
  "rating",
  "rating_count",
  "base_price",
  "owner_user_id",
  "created_at",
  "updated_at",
  "extra_fields",
]);

function extractProductExtraFields(product) {
  const input = (product && typeof product === "object" && !Array.isArray(product))
    ? product
    : {};
  const extrasFromUnknown = {};
  Object.entries(input).forEach(([key, value]) => {
    if (PRODUCT_NORMALIZED_FIELDS.has(key)) return;
    extrasFromUnknown[key] = value;
  });

  const extrasFromField = (
    input.extra_fields &&
    typeof input.extra_fields === "object" &&
    !Array.isArray(input.extra_fields)
  ) ? input.extra_fields : {};

  const merged = deepMerge(
    deepMerge({}, extrasFromUnknown),
    extrasFromField
  );

  return Object.keys(merged).length ? merged : {};
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
    extra_fields: extractProductExtraFields(p),
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

function logActivity({ actor, actionType, targetType = null, targetId = null, details = {} }) {
  if (!actor || !actionType) return;
  const actorRole = String(actor.role || "").trim().toLowerCase();
  if (!["admin", "vendor", "user"].includes(actorRole)) return;
  const safeDetails = details && typeof details === "object" ? details : {};
  try {
    db.prepare(
      `insert into activity_log (
        actor_user_id,
        actor_role,
        action_type,
        target_type,
        target_id,
        details_json,
        created_at
      )
      values (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      Number(actor.id) || null,
      actorRole,
      String(actionType),
      targetType ? String(targetType) : null,
      targetId != null ? String(targetId) : null,
      JSON.stringify(safeDetails)
    );
  } catch (error) {
    console.warn("Activity log write failed:", error.message);
  }
}

function listRecentRoleActivities(roles = ["vendor", "user"], limit = 50) {
  const cleanRoles = Array.isArray(roles)
    ? roles
        .map((role) => String(role || "").trim().toLowerCase())
        .filter((role) => role === "vendor" || role === "user" || role === "admin")
    : [];
  if (!cleanRoles.length) return [];

  const placeholders = cleanRoles.map(() => "?").join(",");
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));

  const rows = db.prepare(
    `select
      al.id,
      al.actor_user_id as actorUserId,
      al.actor_role as actorRole,
      al.action_type as actionType,
      al.target_type as targetType,
      al.target_id as targetId,
      al.details_json as detailsJson,
      al.created_at as createdAt,
      u.name as userName,
      u.email as userEmail
    from activity_log al
    left join users u on u.id = al.actor_user_id
    where al.actor_role in (${placeholders})
    order by al.created_at desc, al.id desc
    limit ?`
  ).all(...cleanRoles, safeLimit);

  let mergedRows = rows;
  if (!mergedRows.length) {
    mergedRows = db.prepare(
      `select
        x.id,
        x.actorUserId,
        x.actorRole,
        x.actionType,
        x.targetType,
        x.targetId,
        x.detailsJson,
        x.createdAt,
        x.userName,
        x.userEmail
       from (
         select
           e.id as id,
           u.id as actorUserId,
           u.role as actorRole,
           'submit_edit' as actionType,
           'edit' as targetType,
           cast(e.id as text) as targetId,
           '{}' as detailsJson,
           e.created_at as createdAt,
           u.name as userName,
           u.email as userEmail
         from edits e
         join users u on u.id = e.user_id
         where u.role = 'vendor'
         union all
         select
           c.id as id,
           u.id as actorUserId,
           u.role as actorRole,
           'comment_product' as actionType,
           'product' as targetType,
           c.product_id as targetId,
           '{}' as detailsJson,
           c.created_at as createdAt,
           u.name as userName,
           u.email as userEmail
         from comments c
         join users u on u.id = c.user_id
         where u.role = 'user'
         union all
         select
           l.rowid as id,
           u.id as actorUserId,
           u.role as actorRole,
           'like_product' as actionType,
           'product' as targetType,
           l.product_id as targetId,
           '{}' as detailsJson,
           l.created_at as createdAt,
           u.name as userName,
           u.email as userEmail
         from likes l
         join users u on u.id = l.user_id
         where u.role = 'user'
       ) x
       where x.actorRole in (${placeholders})
       order by x.createdAt desc, x.id desc
       limit ?`
    ).all(...cleanRoles, safeLimit);
  }

  return mergedRows.map((row) => ({
    id: Number(row.id),
    actorUserId: row.actorUserId == null ? null : Number(row.actorUserId),
    actorRole: String(row.actorRole || ""),
    userName: row.userName || "",
    userEmail: row.userEmail || "",
    actionType: String(row.actionType || ""),
    targetType: row.targetType ? String(row.targetType) : "",
    targetId: row.targetId ? String(row.targetId) : "",
    details: safeJsonParseText(row.detailsJson, {}),
    createdAt: row.createdAt || "",
  }));
}

function getAdminPeopleAndActionSummary() {
  const counts = db.prepare(
    `select
      sum(case when role = 'vendor' then 1 else 0 end) as totalVendors,
      sum(case when role = 'user' then 1 else 0 end) as totalUsers
     from users`
  ).get() || {};

  const actionsByRoleRows = db.prepare(
    `select
      actor_role as role,
      count(*) as total
     from activity_log
     where actor_role in ('vendor', 'user')
     group by actor_role`
  ).all();

  const actionBreakdownRows = db.prepare(
    `select
      actor_role as role,
      action_type as actionType,
      count(*) as total
     from activity_log
     where actor_role in ('vendor', 'user')
     group by actor_role, action_type
     order by actor_role asc, total desc, action_type asc`
  ).all();

  const vendorEditRows = db.prepare(
    `select
      e.status as status,
      count(*) as total
     from edits e
     join users u on u.id = e.user_id
     where u.role = 'vendor'
     group by e.status`
  ).all();

  const vendorEditTotalRow = db.prepare(
    `select count(*) as total
     from edits e
     join users u on u.id = e.user_id
     where u.role = 'vendor'`
  ).get() || {};

  const userActionSnapshot = db.prepare(
    `select
      (select count(*)
       from likes l
       join users u on u.id = l.user_id
       where u.role = 'user') as likesTotal,
      (select count(*)
       from comments c
       join users u on u.id = c.user_id
       where u.role = 'user') as commentsTotal,
      (select count(*)
       from cart_items ci
       join users u on u.id = ci.user_id
       where u.role = 'user') as cartItemsTotal`
  ).get() || {};

  const loggedVendorActions = Number(actionsByRoleRows.find((row) => String(row.role) === "vendor")?.total || 0);
  const loggedUserActions = Number(actionsByRoleRows.find((row) => String(row.role) === "user")?.total || 0);
  const fallbackVendorActions = Number(vendorEditTotalRow.total || 0);
  const fallbackUserActions = Number(userActionSnapshot.likesTotal || 0)
    + Number(userActionSnapshot.commentsTotal || 0)
    + Number(userActionSnapshot.cartItemsTotal || 0);

  const mergedBreakdown = actionBreakdownRows.map((row) => ({
    role: String(row.role || ""),
    actionType: String(row.actionType || ""),
    total: Number(row.total || 0),
  }));
  if (!loggedVendorActions && fallbackVendorActions > 0) {
    mergedBreakdown.push({
      role: "vendor",
      actionType: "submit_edit",
      total: fallbackVendorActions,
    });
  }
  if (!loggedUserActions) {
    const likesTotal = Number(userActionSnapshot.likesTotal || 0);
    const commentsTotal = Number(userActionSnapshot.commentsTotal || 0);
    const cartItemsTotal = Number(userActionSnapshot.cartItemsTotal || 0);
    if (likesTotal > 0) {
      mergedBreakdown.push({ role: "user", actionType: "like_product", total: likesTotal });
    }
    if (commentsTotal > 0) {
      mergedBreakdown.push({ role: "user", actionType: "comment_product", total: commentsTotal });
    }
    if (cartItemsTotal > 0) {
      mergedBreakdown.push({ role: "user", actionType: "cart_items_active", total: cartItemsTotal });
    }
  }

  return {
    totals: {
      vendors: Number(counts.totalVendors || 0),
      users: Number(counts.totalUsers || 0),
    },
    actionsByRole: {
      vendor: loggedVendorActions || fallbackVendorActions,
      user: loggedUserActions || fallbackUserActions,
    },
    actionBreakdown: mergedBreakdown,
    vendorEditSummary: {
      pending: Number(vendorEditRows.find((row) => String(row.status) === "pending")?.total || 0),
      approved: Number(vendorEditRows.find((row) => String(row.status) === "approved")?.total || 0),
      rejected: Number(vendorEditRows.find((row) => String(row.status) === "rejected")?.total || 0),
    },
  };
}

function normalizeAccountStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (ACCOUNT_STATUSES.has(normalized)) return normalized;
  return "active";
}

function parseAccountStatusInput(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ACCOUNT_STATUSES.has(normalized) ? normalized : null;
}

function parsePageNumber(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parsePageSize(value, fallback = 20, max = 200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function compareMaybeDate(a, b, direction = "asc") {
  const factor = direction === "desc" ? -1 : 1;
  const dateA = Date.parse(String(a || ""));
  const dateB = Date.parse(String(b || ""));
  const safeA = Number.isFinite(dateA) ? dateA : 0;
  const safeB = Number.isFinite(dateB) ? dateB : 0;
  if (safeA === safeB) return 0;
  return safeA > safeB ? factor : -factor;
}

function compareMaybeText(a, b, direction = "asc") {
  const factor = direction === "desc" ? -1 : 1;
  const textA = String(a || "").toLowerCase();
  const textB = String(b || "").toLowerCase();
  if (textA === textB) return 0;
  return textA > textB ? factor : -factor;
}

function compareMaybeNumber(a, b, direction = "asc") {
  const factor = direction === "desc" ? -1 : 1;
  const numA = Number(a || 0);
  const numB = Number(b || 0);
  if (numA === numB) return 0;
  return numA > numB ? factor : -factor;
}

function buildProductsCountByOwner() {
  const counts = new Map();
  getProductsArray().forEach((product) => {
    const ownerId = toNumberOrNull(product.owner_user_id);
    if (!ownerId) return;
    counts.set(ownerId, Number(counts.get(ownerId) || 0) + 1);
  });
  return counts;
}

function sanitizeRoleListSort(role, sortByRaw) {
  const normalized = String(sortByRaw || "").trim().toLowerCase();
  const allowedCommon = new Set(["name", "email", "created_at", "last_login_at", "status"]);
  if (role === "vendor" && normalized === "products_count") return "products_count";
  return allowedCommon.has(normalized) ? normalized : "created_at";
}

function listAccountsByRole({ role, query = {} }) {
  const page = parsePageNumber(query.page, 1);
  const pageSize = parsePageSize(query.page_size ?? query.pageSize, 20, 200);
  const search = String(query.search || "").trim().toLowerCase();
  const status = String(query.status || "").trim().toLowerCase();
  const sortBy = sanitizeRoleListSort(role, query.sort_by || query.sortBy);
  const sortDir = String(query.sort_dir || query.sortDir || "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";

  const where = ["role = ?"];
  const params = [role];
  if (search) {
    where.push("(lower(name) like ? or lower(email) like ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (status && ACCOUNT_STATUSES.has(status)) {
    where.push("coalesce(lower(status), 'active') = ?");
    params.push(status);
  }

  const whereSql = where.join(" and ");
  const countRow = db.prepare(`select count(*) as total from users where ${whereSql}`).get(...params) || {};
  const total = Number(countRow.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const normalizedPage = Math.min(page, totalPages);
  const offset = (normalizedPage - 1) * pageSize;

  const productsCountByOwner = role === "vendor" ? buildProductsCountByOwner() : new Map();

  let rows;
  if (sortBy === "products_count" && role === "vendor") {
    rows = db.prepare(
      `select
        id,
        name,
        email,
        role,
        slug,
        coalesce(status, 'active') as status,
        created_at,
        last_login_at,
        password_changed_at,
        coalesce(session_version, 0) as session_version
      from users
      where ${whereSql}`
    ).all(...params);
  } else {
    const sortColumn = (
      sortBy === "name" ||
      sortBy === "email" ||
      sortBy === "created_at" ||
      sortBy === "last_login_at" ||
      sortBy === "status"
    ) ? sortBy : "created_at";

    rows = db.prepare(
      `select
        id,
        name,
        email,
        role,
        slug,
        coalesce(status, 'active') as status,
        created_at,
        last_login_at,
        password_changed_at,
        coalesce(session_version, 0) as session_version
      from users
      where ${whereSql}
      order by ${sortColumn} ${sortDir}, id asc
      limit ? offset ?`
    ).all(...params, pageSize, offset);
  }

  let items = rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name || ""),
    email: String(row.email || ""),
    role: String(row.role || ""),
    slug: String(row.slug || ""),
    status: normalizeAccountStatus(row.status),
    createdAt: row.created_at || "",
    lastLoginAt: row.last_login_at || null,
    passwordChangedAt: row.password_changed_at || null,
    productsCount: role === "vendor" ? Number(productsCountByOwner.get(Number(row.id)) || 0) : undefined,
  }));

  if (sortBy === "products_count" && role === "vendor") {
    items.sort((a, b) => {
      const order = compareMaybeNumber(a.productsCount, b.productsCount, sortDir);
      if (order !== 0) return order;
      return compareMaybeNumber(a.id, b.id, "asc");
    });
    const start = (normalizedPage - 1) * pageSize;
    items = items.slice(start, start + pageSize);
  }

  return {
    items,
    paging: {
      total,
      page: normalizedPage,
      pageSize,
      totalPages,
      hasPrev: normalizedPage > 1,
      hasNext: normalizedPage < totalPages,
    },
    filters: {
      search,
      status: status && ACCOUNT_STATUSES.has(status) ? status : "",
    },
    sort: {
      sortBy,
      sortDir,
    },
  };
}

function getAdminDashboardCounts() {
  const row = db.prepare(
    `select
      sum(case when role = 'user' then 1 else 0 end) as users_count,
      sum(case when role = 'vendor' then 1 else 0 end) as vendors_count
    from users`
  ).get() || {};
  return {
    usersCount: Number(row.users_count || 0),
    vendorsCount: Number(row.vendors_count || 0),
  };
}

function getAccountById(role, id) {
  const userId = Number(id);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const row = db.prepare(
    `select
      id,
      name,
      email,
      role,
      slug,
      coalesce(status, 'active') as status,
      created_at,
      last_login_at,
      password_changed_at,
      coalesce(session_version, 0) as session_version
    from users
    where id = ? and role = ?`
  ).get(userId, role);
  if (!row) return null;
  return {
    id: Number(row.id),
    name: String(row.name || ""),
    email: String(row.email || ""),
    role: String(row.role || ""),
    slug: String(row.slug || ""),
    status: normalizeAccountStatus(row.status),
    createdAt: row.created_at || "",
    lastLoginAt: row.last_login_at || null,
    passwordChangedAt: row.password_changed_at || null,
    sessionVersion: Number(row.session_version || 0),
  };
}

function setAccountStatus({ role, targetId, status, actor }) {
  const target = getAccountById(role, targetId);
  if (!target) {
    const err = new Error(role === "vendor" ? "Vendor not found." : "User not found.");
    err.statusCode = 404;
    throw err;
  }
  const normalizedStatus = parseAccountStatusInput(status);
  if (!normalizedStatus) {
    const err = new Error("Status must be either 'active' or 'disabled'.");
    err.statusCode = 400;
    throw err;
  }
  db.prepare(
    `update users
     set status = ?,
         session_version = case when ? = 'disabled' then coalesce(session_version, 0) + 1 else coalesce(session_version, 0) end
     where id = ?`
  ).run(normalizedStatus, normalizedStatus, Number(target.id));

  const updated = getAccountById(role, target.id);
  logActivity({
    actor,
    actionType: normalizedStatus === "disabled" ? "disable_account" : "enable_account",
    targetType: "account",
    targetId: target.id,
    details: { role },
  });
  return updated;
}

function revokeAccountSessions({ role, targetId, actor }) {
  const target = getAccountById(role, targetId);
  if (!target) {
    const err = new Error(role === "vendor" ? "Vendor not found." : "User not found.");
    err.statusCode = 404;
    throw err;
  }
  db.prepare("update users set session_version = coalesce(session_version, 0) + 1 where id = ?")
    .run(Number(target.id));
  logActivity({
    actor,
    actionType: "revoke_sessions",
    targetType: "account",
    targetId: target.id,
    details: { role },
  });
}

function deleteAccount({ role, targetId, actor }) {
  const target = getAccountById(role, targetId);
  if (!target) {
    const err = new Error(role === "vendor" ? "Vendor not found." : "User not found.");
    err.statusCode = 404;
    throw err;
  }
  if (Number(target.id) === Number(actor.id)) {
    const err = new Error("You cannot delete your own account.");
    err.statusCode = 400;
    throw err;
  }

  if (role === "vendor") {
    const state = getSiteState();
    state.products = (state.products || []).filter((product) => Number(product.owner_user_id) !== Number(target.id));
    saveSiteState(state, actor.id);
  }

  db.prepare("delete from users where id = ? and role = ?").run(Number(target.id), role);
  logActivity({
    actor,
    actionType: "delete_account",
    targetType: "account",
    targetId: target.id,
    details: { role, email: target.email },
  });
  return target;
}

function getPublicProductByIdMap() {
  return new Map(getProductsArray().map((product) => [String(product.id), product]));
}

function getUserActivityDetails(userId) {
  const byProductId = getPublicProductByIdMap();
  const likes = db.prepare(
    `select product_id as productId, created_at as createdAt
     from likes
     where user_id = ?
     order by created_at desc`
  ).all(Number(userId)).map((row) => ({
    productId: String(row.productId || ""),
    productName: byProductId.get(String(row.productId || ""))?.name || "",
    createdAt: row.createdAt || "",
  }));

  const comments = db.prepare(
    `select
      id,
      product_id as productId,
      content,
      created_at as createdAt
     from comments
     where user_id = ?
     order by created_at desc`
  ).all(Number(userId)).map((row) => ({
    id: Number(row.id),
    productId: String(row.productId || ""),
    productName: byProductId.get(String(row.productId || ""))?.name || "",
    content: String(row.content || ""),
    createdAt: row.createdAt || "",
  }));

  const cart = serializeCart(userId);
  const cartUpdates = db.prepare(
    `select
      id,
      action_type as actionType,
      target_id as targetId,
      created_at as createdAt
     from activity_log
     where actor_user_id = ?
       and action_type like 'cart_%'
     order by created_at desc
     limit 100`
  ).all(Number(userId)).map((row) => ({
    id: Number(row.id),
    actionType: String(row.actionType || ""),
    targetId: String(row.targetId || ""),
    createdAt: row.createdAt || "",
  }));

  return {
    likes,
    comments,
    cart,
    cartUpdates,
  };
}

function listVendorProducts(vendorId) {
  const current = getProductsArray();
  return current
    .filter((product) => Number(product.owner_user_id) === Number(vendorId))
    .sort((a, b) => compareProducts(a, b, "sort_order", "asc"));
}

function createTokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function buildBaseOrigin(req) {
  const host = String(req.get("host") || `localhost:${PORT}`);
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || req.protocol || "http";
  return `${protocol}://${host}`;
}

function createPasswordResetForUser({ targetUser, adminUser, req }) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = createTokenHash(rawToken);
  const expiresAt = new Date(Date.now() + (60 * 60 * 1000)).toISOString();

  db.prepare(
    `insert into password_reset_tokens (user_id, token_hash, expires_at, created_by_admin_id)
     values (?, ?, ?, ?)`
  ).run(Number(targetUser.id), tokenHash, expiresAt, Number(adminUser.id));

  const resetLink = `${buildBaseOrigin(req)}/reset-password?token=${encodeURIComponent(rawToken)}`;
  return { resetLink, expiresAt };
}

function validateNewPassword(password) {
  const raw = String(password || "");
  if (!raw) {
    const err = new Error("Password is required.");
    err.statusCode = 400;
    throw err;
  }
  if (raw.length < 8) {
    const err = new Error("Password must be at least 8 characters.");
    err.statusCode = 400;
    throw err;
  }
  if (raw.length > 200) {
    const err = new Error("Password is too long.");
    err.statusCode = 400;
    throw err;
  }
  return raw;
}

function consumePasswordResetToken({ token, password }) {
  const tokenHash = createTokenHash(token);
  const row = db.prepare(
    `select
      prt.id,
      prt.user_id,
      prt.expires_at,
      prt.used_at,
      u.id as account_id,
      u.name as account_name,
      u.email as account_email,
      u.role as account_role
    from password_reset_tokens prt
    join users u on u.id = prt.user_id
    where prt.token_hash = ?`
  ).get(tokenHash);

  if (!row) {
    const err = new Error("Reset link is invalid.");
    err.statusCode = 400;
    throw err;
  }
  if (row.used_at) {
    const err = new Error("Reset link has already been used.");
    err.statusCode = 400;
    throw err;
  }
  const expiry = Date.parse(String(row.expires_at || ""));
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    const err = new Error("Reset link has expired.");
    err.statusCode = 400;
    throw err;
  }

  const newPassword = validateNewPassword(password);
  const passwordHash = passwordUtils.hashSync(newPassword, 12);
  db.prepare(
    `update users
     set password_hash = ?, password_changed_at = datetime('now'), session_version = coalesce(session_version, 0) + 1
     where id = ?`
  ).run(passwordHash, Number(row.account_id));
  db.prepare("update password_reset_tokens set used_at = datetime('now') where id = ?")
    .run(Number(row.id));

  return {
    user: {
      id: Number(row.account_id),
      name: String(row.account_name || ""),
      email: String(row.account_email || ""),
      role: String(row.account_role || ""),
    },
  };
}

function flattenForDiff(value, prefix, output) {
  if (Array.isArray(value)) {
    if (!value.length) {
      output[prefix] = [];
      return;
    }
    value.forEach((item, index) => {
      const nextPrefix = prefix ? `${prefix}[${index}]` : `[${index}]`;
      flattenForDiff(item, nextPrefix, output);
    });
    return;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) {
      output[prefix] = {};
      return;
    }
    keys.forEach((key) => {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenForDiff(value[key], nextPrefix, output);
    });
    return;
  }
  output[prefix || "(root)"] = value;
}

function buildSubmissionDiff(baseSnapshot, requestedSnapshot) {
  const baseFlat = {};
  const requestedFlat = {};
  flattenForDiff(baseSnapshot || {}, "", baseFlat);
  flattenForDiff(requestedSnapshot || {}, "", requestedFlat);

  const keys = Array.from(new Set([...Object.keys(baseFlat), ...Object.keys(requestedFlat)])).sort();
  return keys.map((field) => {
    const currentValue = Object.prototype.hasOwnProperty.call(baseFlat, field) ? baseFlat[field] : null;
    const requestedValue = Object.prototype.hasOwnProperty.call(requestedFlat, field) ? requestedFlat[field] : null;
    return {
      field,
      currentValue,
      requestedValue,
      changed: JSON.stringify(currentValue) !== JSON.stringify(requestedValue),
    };
  });
}

function serializeSubmissionRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    vendorId: Number(row.vendor_id),
    vendorName: String(row.vendor_name || ""),
    vendorEmail: String(row.vendor_email || ""),
    productId: String(row.product_id || ""),
    submissionType: String(row.submission_type || "update"),
    snapshot: safeJsonParseText(row.snapshot_json, {}),
    baseSnapshot: row.base_snapshot_json ? safeJsonParseText(row.base_snapshot_json, null) : null,
    vendorNote: row.vendor_note || "",
    status: String(row.status || "pending"),
    rejectionReason: row.rejection_reason || "",
    createdAt: row.created_at || "",
    reviewedAt: row.reviewed_at || null,
    reviewedBy: row.reviewed_by == null ? null : Number(row.reviewed_by),
    reviewedByName: row.reviewer_name || null,
  };
}

function submissionToLegacyEdit(submission) {
  if (!submission) return null;
  const snapshot = submission.snapshot || {};
  return {
    id: submission.id,
    userId: submission.vendorId,
    userName: submission.vendorName,
    userEmail: submission.vendorEmail,
    title: `Product submission: ${snapshot.name || submission.productId}`,
    description: submission.vendorNote || "",
    payload: {
      target: "vendor_products",
      product_changes: [snapshot],
      product_submission_id: submission.id,
      product_id: submission.productId,
      submission_type: submission.submissionType,
    },
    status: submission.status,
    createdAt: submission.createdAt,
    approvedAt: submission.reviewedAt,
    approvedBy: submission.reviewedBy,
    approvedByName: submission.reviewedByName,
    rejectionReason: submission.rejectionReason || "",
  };
}

function getSubmissionRowById(submissionId) {
  return db.prepare(
    `select
      ps.id,
      ps.vendor_id,
      v.name as vendor_name,
      v.email as vendor_email,
      ps.product_id,
      ps.submission_type,
      ps.snapshot_json,
      ps.base_snapshot_json,
      ps.vendor_note,
      ps.status,
      ps.rejection_reason,
      ps.created_at,
      ps.reviewed_at,
      ps.reviewed_by,
      r.name as reviewer_name
    from product_submissions ps
    join users v on v.id = ps.vendor_id
    left join users r on r.id = ps.reviewed_by
    where ps.id = ?`
  ).get(Number(submissionId));
}

function getSubmissionForActor(submissionId, actor) {
  const row = getSubmissionRowById(submissionId);
  const submission = serializeSubmissionRow(row);
  if (!submission) return null;
  if (actor.role === "vendor" && Number(submission.vendorId) !== Number(actor.id)) {
    return null;
  }
  return {
    ...submission,
    diff: buildSubmissionDiff(submission.baseSnapshot || {}, submission.snapshot || {}),
  };
}

function listProductSubmissions({ actor, query = {} }) {
  const page = parsePageNumber(query.page, 1);
  const pageSize = parsePageSize(query.page_size ?? query.pageSize, 20, 200);
  const search = String(query.search || "").trim().toLowerCase();
  const status = normalizeStatus(query.status) || "";
  const sortByRaw = String(query.sort_by || query.sortBy || "created_at").trim().toLowerCase();
  const sortBy = ["created_at", "status", "product_id"].includes(sortByRaw) ? sortByRaw : "created_at";
  const sortDir = String(query.sort_dir || query.sortDir || "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";

  const where = [];
  const params = [];
  if (actor.role === "vendor") {
    where.push("ps.vendor_id = ?");
    params.push(Number(actor.id));
  } else if (actor.role === "admin") {
    const vendorIdFilter = Number(query.vendor_id || query.vendorId || 0);
    if (Number.isInteger(vendorIdFilter) && vendorIdFilter > 0) {
      where.push("ps.vendor_id = ?");
      params.push(vendorIdFilter);
    }
  }
  if (status) {
    where.push("ps.status = ?");
    params.push(status);
  }
  if (search) {
    where.push("(lower(v.name) like ? or lower(v.email) like ? or lower(ps.product_id) like ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const countRow = db.prepare(
    `select count(*) as total
     from product_submissions ps
     join users v on v.id = ps.vendor_id
     ${whereSql}`
  ).get(...params) || {};
  const total = Number(countRow.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const normalizedPage = Math.min(page, totalPages);
  const offset = (normalizedPage - 1) * pageSize;

  const rows = db.prepare(
    `select
      ps.id,
      ps.vendor_id,
      v.name as vendor_name,
      v.email as vendor_email,
      ps.product_id,
      ps.submission_type,
      ps.snapshot_json,
      ps.base_snapshot_json,
      ps.vendor_note,
      ps.status,
      ps.rejection_reason,
      ps.created_at,
      ps.reviewed_at,
      ps.reviewed_by,
      r.name as reviewer_name
    from product_submissions ps
    join users v on v.id = ps.vendor_id
    left join users r on r.id = ps.reviewed_by
    ${whereSql}
    order by ps.${sortBy} ${sortDir}, ps.id ${sortDir}
    limit ? offset ?`
  ).all(...params, pageSize, offset);

  return {
    items: rows.map(serializeSubmissionRow),
    paging: {
      total,
      page: normalizedPage,
      pageSize,
      totalPages,
      hasPrev: normalizedPage > 1,
      hasNext: normalizedPage < totalPages,
    },
    filters: { search, status },
    sort: { sortBy, sortDir },
  };
}

function createProductSubmissionsFromVendorPayload({ vendorUser, payload, title, description }) {
  const currentState = getSiteState();
  const existingById = new Map((currentState.products || []).map((product) => [String(product.id), product]));
  const incoming = Array.isArray(payload?.product_changes) ? payload.product_changes : [];
  if (!incoming.length) {
    const err = new Error("At least one product change is required.");
    err.statusCode = 400;
    throw err;
  }

  const created = [];
  incoming.forEach((product, index) => {
    const normalizedSnapshot = normalizeProduct(
      { ...product, owner_user_id: Number(vendorUser.id) },
      index
    );
    const existing = existingById.get(String(normalizedSnapshot.id));
    if (existing && Number(existing.owner_user_id) !== Number(vendorUser.id)) {
      const err = new Error("You can edit only your own products.");
      err.statusCode = 403;
      throw err;
    }

    const submissionType = existing ? "update" : "create";
    const baseSnapshot = existing ? normalizeProduct(existing) : null;
    const info = db.prepare(
      `insert into product_submissions (
        vendor_id,
        product_id,
        submission_type,
        snapshot_json,
        base_snapshot_json,
        vendor_note,
        status,
        created_at
      ) values (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
    ).run(
      Number(vendorUser.id),
      String(normalizedSnapshot.id),
      submissionType,
      JSON.stringify(normalizedSnapshot),
      baseSnapshot ? JSON.stringify(baseSnapshot) : null,
      String(description || title || "").trim()
    );

    const inserted = serializeSubmissionRow(getSubmissionRowById(Number(info.lastInsertRowid)));
    if (inserted) {
      created.push(inserted);
      logActivity({
        actor: vendorUser,
        actionType: "submit_product_submission",
        targetType: "product_submission",
        targetId: inserted.id,
        details: {
          submissionType,
          productId: inserted.productId,
        },
      });
    }
  });

  return created;
}

function approveSubmission({ submissionId, adminUser }) {
  const existingRow = getSubmissionRowById(submissionId);
  const existing = serializeSubmissionRow(existingRow);
  if (!existing) {
    const err = new Error("Submission not found.");
    err.statusCode = 404;
    throw err;
  }
  if (existing.status !== "pending") {
    const err = new Error("Only pending submissions can be reviewed.");
    err.statusCode = 409;
    throw err;
  }

  const snapshot = normalizeProduct(existing.snapshot || {});
  const current = getSiteState();
  current.products = mergeProductChanges(current.products, [snapshot]);
  saveSiteState(current, adminUser.id);

  db.prepare(
    `update product_submissions
     set status = 'approved',
         rejection_reason = null,
         reviewed_at = datetime('now'),
         reviewed_by = ?
     where id = ?`
  ).run(Number(adminUser.id), Number(submissionId));

  logActivity({
    actor: adminUser,
    actionType: "approve_submission",
    targetType: "product_submission",
    targetId: Number(submissionId),
    details: { vendorId: existing.vendorId, productId: existing.productId },
  });

  return serializeSubmissionRow(getSubmissionRowById(submissionId));
}

function rejectSubmission({ submissionId, adminUser, reason }) {
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) {
    const err = new Error("Reject reason is required.");
    err.statusCode = 400;
    throw err;
  }
  if (cleanReason.length > 2000) {
    const err = new Error("Reject reason must be 2000 characters or fewer.");
    err.statusCode = 400;
    throw err;
  }

  const existing = serializeSubmissionRow(getSubmissionRowById(submissionId));
  if (!existing) {
    const err = new Error("Submission not found.");
    err.statusCode = 404;
    throw err;
  }
  if (existing.status !== "pending") {
    const err = new Error("Only pending submissions can be reviewed.");
    err.statusCode = 409;
    throw err;
  }

  db.prepare(
    `update product_submissions
     set status = 'rejected',
         rejection_reason = ?,
         reviewed_at = datetime('now'),
         reviewed_by = ?
     where id = ?`
  ).run(cleanReason, Number(adminUser.id), Number(submissionId));

  logActivity({
    actor: adminUser,
    actionType: "reject_submission",
    targetType: "product_submission",
    targetId: Number(submissionId),
    details: { vendorId: existing.vendorId, productId: existing.productId },
  });

  return serializeSubmissionRow(getSubmissionRowById(submissionId));
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

app.get("/reset-password", (req, res) => {
  return res.render("reset-password", {
    token: String(req.query.token || ""),
  });
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

app.get("/admin/content", requireAdmin, (req, res) => {
  return res.redirect("/admin");
});

app.get("/admin/dashboard", requireAdmin, (req, res) => {
  const counts = getAdminDashboardCounts();
  return res.render("admin-dashboard-counts", {
    counts,
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

app.get("/admin/users", requireAdmin, (req, res) => {
  const result = listAccountsByRole({
    role: "user",
    query: req.query || {},
  });
  return res.render("admin-user-list", {
    listing: result,
    query: req.query || {},
  });
});

app.get("/admin/users/:id", requireAdmin, (req, res) => {
  const targetUser = getAccountById("user", req.params.id);
  if (!targetUser) {
    return res.status(404).render("error", {
      title: "User not found",
      message: "This user does not exist.",
    });
  }
  const activity = getUserActivityDetails(targetUser.id);
  const authMeta = {
    hasPasswordSet: true,
    provider: "password",
    passwordChangedAt: targetUser.passwordChangedAt,
    lastLoginAt: targetUser.lastLoginAt,
  };

  return res.render("admin-user-view", {
    targetUser,
    activity,
    authMeta,
  });
});

app.get("/admin/vendors", requireAdmin, (req, res) => {
  const result = listAccountsByRole({
    role: "vendor",
    query: req.query || {},
  });
  return res.render("admin-vendor-list", {
    listing: result,
    query: req.query || {},
  });
});

app.get("/admin/vendors/:id", requireAdmin, (req, res) => {
  const targetVendor = getAccountById("vendor", req.params.id);
  if (!targetVendor) {
    return res.status(404).render("error", {
      title: "Vendor not found",
      message: "This vendor does not exist.",
    });
  }

  const products = listVendorProducts(targetVendor.id);
  const submissions = listProductSubmissions({
    actor: req.user,
    query: {
      vendor_id: targetVendor.id,
      page: req.query.page || 1,
      page_size: req.query.page_size || 50,
      status: req.query.status || "",
      sort_by: "created_at",
      sort_dir: "desc",
    },
  });

  const authMeta = {
    hasPasswordSet: true,
    provider: "password",
    passwordChangedAt: targetVendor.passwordChangedAt,
    lastLoginAt: targetVendor.lastLoginAt,
  };

  return res.render("admin-vendor-view", {
    targetVendor,
    products,
    submissions,
    authMeta,
  });
});

app.get("/admin/submissions", requireAdmin, (req, res) => {
  const result = listProductSubmissions({
    actor: req.user,
    query: req.query || {},
  });
  return res.render("admin-submission-list", {
    listing: result,
    query: req.query || {},
  });
});

app.get("/admin/submissions/:id", requireAdmin, (req, res) => {
  const submission = getSubmissionForActor(req.params.id, req.user);
  if (!submission) {
    return res.status(404).render("error", {
      title: "Submission not found",
      message: "This submission does not exist.",
    });
  }
  return res.render("admin-submission-view", { submission });
});

app.get("/admin/overview", requireAdmin, (req, res) => {
  return res.redirect("/admin/dashboard");
});

app.get("/admin/edits", requireAdmin, (req, res) => {
  return res.redirect("/admin/submissions");
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
    .prepare("select id, name, email, role, slug, status, coalesce(session_version, 0) as session_version from users where id = ?")
    .get(createdId);

  const token = signSessionToken(user);
  setSessionCookie(res, token);
  logActivity({
    actor: user,
    actionType: "vendor_signup",
    targetType: "account",
    targetId: user.id,
    details: { email: user.email },
  });

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
    .prepare("select id, name, email, role, slug, status, coalesce(session_version, 0) as session_version, password_hash from users where email = ?")
    .get(email);
  if (!user || !passwordUtils.compareSync(plainPassword, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  if (normalizeAccountStatus(user.status) !== "active") {
    return res.status(403).json({ error: "This account is disabled." });
  }
  if (user.role === "user") {
    return res.status(403).json({ error: "Use the User login page for this account." });
  }

  db.prepare("update users set last_login_at = datetime('now') where id = ?").run(Number(user.id));
  const refreshedUser = db
    .prepare("select id, name, email, role, slug, status, coalesce(session_version, 0) as session_version from users where id = ?")
    .get(Number(user.id));

  const token = signSessionToken(refreshedUser);
  setSessionCookie(res, token);

  return res.json({
    message: "Signed in successfully.",
    user: buildSessionUser(refreshedUser),
    redirect: refreshedUser.role === "admin" ? "/admin" : `/panel/${refreshedUser.slug}`,
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
    .prepare("select id, name, email, role, slug, status, coalesce(session_version, 0) as session_version from users where id = ?")
    .get(createdId);

  const token = signSessionToken(user);
  setSessionCookie(res, token);
  logActivity({
    actor: user,
    actionType: "user_signup",
    targetType: "account",
    targetId: user.id,
    details: { email: user.email },
  });

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
    .prepare("select id, name, email, role, slug, status, coalesce(session_version, 0) as session_version, password_hash from users where email = ?")
    .get(email);
  if (!user || !passwordUtils.compareSync(plainPassword, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  if (normalizeAccountStatus(user.status) !== "active") {
    return res.status(403).json({ error: "This account is disabled." });
  }
  if (user.role !== "user") {
    return res.status(403).json({ error: "This account is not a standard user account." });
  }

  db.prepare("update users set last_login_at = datetime('now') where id = ?").run(Number(user.id));
  const refreshedUser = db
    .prepare("select id, name, email, role, slug, status, coalesce(session_version, 0) as session_version from users where id = ?")
    .get(Number(user.id));

  const token = signSessionToken(refreshedUser);
  setSessionCookie(res, token);

  return res.json({
    message: "Signed in successfully.",
    user: buildSessionUser(refreshedUser),
    redirect: "/user/panel",
  });
});

app.post("/api/auth/reset-password", (req, res) => {
  const token = String(req.body?.token || "").trim();
  const password = String(req.body?.password || "");
  if (!token) {
    return res.status(400).json({ error: "Reset token is required." });
  }

  const result = consumePasswordResetToken({ token, password });
  logActivity({
    actor: {
      id: result.user.id,
      role: result.user.role,
      name: result.user.name,
      email: result.user.email,
    },
    actionType: "password_reset_complete",
    targetType: "account",
    targetId: result.user.id,
    details: {},
  });

  return res.json({ message: "Password has been reset successfully. Please sign in." });
});

app.post("/api/auth/signout", (req, res) => {
  clearSessionCookie(res);
  return res.json({ message: "Signed out." });
});

app.get("/api/me", requireAuth, (req, res) => {
  return res.json({ user: buildSessionUser(req.user) });
});

app.get("/api/admin/dashboard-counts", requireAdmin, (req, res) => {
  return res.json(getAdminDashboardCounts());
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const result = listAccountsByRole({
    role: "user",
    query: req.query || {},
  });
  return res.json(result);
});

app.get("/api/admin/users/:id", requireAdmin, (req, res) => {
  const targetUser = getAccountById("user", req.params.id);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found." });
  }
  return res.json({
    user: targetUser,
    auth: {
      hasPasswordSet: true,
      provider: "password",
      passwordChangedAt: targetUser.passwordChangedAt,
      lastLoginAt: targetUser.lastLoginAt,
    },
    activity: getUserActivityDetails(targetUser.id),
  });
});

app.patch("/api/admin/users/:id/status", requireAdmin, (req, res) => {
  const status = req.body?.status;
  const updated = setAccountStatus({
    role: "user",
    targetId: req.params.id,
    status,
    actor: req.user,
  });
  return res.json({ message: "User status updated.", user: updated });
});

app.post("/api/admin/users/:id/revoke-sessions", requireAdmin, (req, res) => {
  revokeAccountSessions({
    role: "user",
    targetId: req.params.id,
    actor: req.user,
  });
  return res.json({ message: "User sessions revoked." });
});

app.post("/api/admin/users/:id/password-reset", requireAdmin, (req, res) => {
  const targetUser = getAccountById("user", req.params.id);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found." });
  }
  const reset = createPasswordResetForUser({
    targetUser,
    adminUser: req.user,
    req,
  });
  logActivity({
    actor: req.user,
    actionType: "trigger_password_reset",
    targetType: "account",
    targetId: targetUser.id,
    details: { role: "user" },
  });
  return res.json({
    message: "Password reset link generated.",
    resetLink: reset.resetLink,
    expiresAt: reset.expiresAt,
  });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  const deleted = deleteAccount({
    role: "user",
    targetId: req.params.id,
    actor: req.user,
  });
  return res.json({
    message: "User deleted.",
    deleted: {
      id: deleted.id,
      name: deleted.name,
      email: deleted.email,
    },
  });
});

app.get("/api/admin/vendors", requireAdmin, (req, res) => {
  const result = listAccountsByRole({
    role: "vendor",
    query: req.query || {},
  });
  return res.json(result);
});

app.get("/api/admin/vendors/:id", requireAdmin, (req, res) => {
  const targetVendor = getAccountById("vendor", req.params.id);
  if (!targetVendor) {
    return res.status(404).json({ error: "Vendor not found." });
  }
  const submissions = listProductSubmissions({
    actor: req.user,
    query: {
      vendor_id: targetVendor.id,
      page: req.query.page || 1,
      page_size: req.query.page_size || 100,
      status: req.query.status || "",
      sort_by: req.query.sort_by || "created_at",
      sort_dir: req.query.sort_dir || "desc",
    },
  });
  return res.json({
    vendor: targetVendor,
    auth: {
      hasPasswordSet: true,
      provider: "password",
      passwordChangedAt: targetVendor.passwordChangedAt,
      lastLoginAt: targetVendor.lastLoginAt,
    },
    products: listVendorProducts(targetVendor.id),
    submissions,
  });
});

app.patch("/api/admin/vendors/:id/status", requireAdmin, (req, res) => {
  const status = req.body?.status;
  const updated = setAccountStatus({
    role: "vendor",
    targetId: req.params.id,
    status,
    actor: req.user,
  });
  return res.json({ message: "Vendor status updated.", vendor: updated });
});

app.post("/api/admin/vendors/:id/revoke-sessions", requireAdmin, (req, res) => {
  revokeAccountSessions({
    role: "vendor",
    targetId: req.params.id,
    actor: req.user,
  });
  return res.json({ message: "Vendor sessions revoked." });
});

app.post("/api/admin/vendors/:id/password-reset", requireAdmin, (req, res) => {
  const targetVendor = getAccountById("vendor", req.params.id);
  if (!targetVendor) {
    return res.status(404).json({ error: "Vendor not found." });
  }
  const reset = createPasswordResetForUser({
    targetUser: targetVendor,
    adminUser: req.user,
    req,
  });
  logActivity({
    actor: req.user,
    actionType: "trigger_password_reset",
    targetType: "account",
    targetId: targetVendor.id,
    details: { role: "vendor" },
  });
  return res.json({
    message: "Password reset link generated.",
    resetLink: reset.resetLink,
    expiresAt: reset.expiresAt,
  });
});

app.delete("/api/admin/vendors/:id", requireAdmin, (req, res) => {
  const deleted = deleteAccount({
    role: "vendor",
    targetId: req.params.id,
    actor: req.user,
  });
  return res.json({
    message: "Vendor deleted.",
    deleted: {
      id: deleted.id,
      name: deleted.name,
      email: deleted.email,
    },
  });
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
  logActivity({
    actor: req.user,
    actionType: "save_site_content",
    targetType: "site",
    targetId: "current",
    details: {},
  });
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
  logActivity({
    actor: req.user,
    actionType: "save_site_section",
    targetType: "site_section",
    targetId: sectionKey,
    details: {},
  });
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
  logActivity({
    actor: req.user,
    actionType: "admin_create_product",
    targetType: "product",
    targetId: product.id,
    details: {},
  });
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
  logActivity({
    actor: req.user,
    actionType: "admin_update_product",
    targetType: "product",
    targetId: productId,
    details: {},
  });
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
  logActivity({
    actor: req.user,
    actionType: "admin_delete_product",
    targetType: "product",
    targetId: productId,
    details: {},
  });
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

  const createdSubmissions = createProductSubmissionsFromVendorPayload({
    vendorUser: req.user,
    payload: payloadToSave,
    title,
    description,
  });

  return res.status(201).json({
    message: "Submission sent for admin approval.",
    edit: submissionToLegacyEdit(createdSubmissions[0]),
    submissions: createdSubmissions,
  });
});

app.get("/api/edits", requireAuth, (req, res) => {
  if (req.user.role === "user") return res.json({ edits: [] });
  const submissions = listProductSubmissions({
    actor: req.user,
    query: {
      status: req.query.status,
      page: 1,
      page_size: 500,
      search: req.query.search || "",
      sort_by: "created_at",
      sort_dir: "desc",
    },
  });
  return res.json({ edits: submissions.items.map(submissionToLegacyEdit) });
});

function setEditDecision(decision) {
  return (req, res) => {
    const editId = Number(req.params.id);
    if (!Number.isInteger(editId) || editId <= 0) {
      return res.status(400).json({ error: "Edit id must be a positive integer." });
    }
    try {
      const submission = decision === "approved"
        ? approveSubmission({ submissionId: editId, adminUser: req.user })
        : rejectSubmission({
            submissionId: editId,
            adminUser: req.user,
            reason: req.body?.reason,
          });
      return res.json({
        message: decision === "approved" ? "Submission approved." : "Submission rejected.",
        edit: submissionToLegacyEdit(submission),
      });
    } catch (error) {
      return res.status(Number(error.statusCode) || 400).json({ error: error.message || "Could not review submission." });
    }
  };
}

app.patch("/api/edits/:id/approve", requireAdmin, setEditDecision("approved"));
app.patch("/api/edits/:id/reject", requireAdmin, setEditDecision("rejected"));

app.get("/api/submissions", requireAdminOrVendor, (req, res) => {
  const result = listProductSubmissions({
    actor: req.user,
    query: req.query || {},
  });
  return res.json(result);
});

app.post("/api/submissions", requireVendor, (req, res) => {
  const payloadInput = req.body?.payload;
  const payload = payloadInput && typeof payloadInput === "object" ? payloadInput : req.body;
  let validatedPayload;
  try {
    validatedPayload = buildVendorProductPayload(payload, req.user.id);
  } catch (error) {
    return res.status(Number(error.statusCode) || 400).json({ error: error.message || "Invalid submission payload." });
  }

  const title = String(req.body?.title || "Product submission").trim() || "Product submission";
  const description = String(req.body?.description || req.body?.vendor_note || "").trim();
  const created = createProductSubmissionsFromVendorPayload({
    vendorUser: req.user,
    payload: validatedPayload,
    title,
    description,
  });

  return res.status(201).json({
    message: "Submission created.",
    submissions: created,
  });
});

app.get("/api/admin/submissions", requireAdmin, (req, res) => {
  const result = listProductSubmissions({
    actor: req.user,
    query: req.query || {},
  });
  return res.json(result);
});

app.get("/api/admin/submissions/:id", requireAdmin, (req, res) => {
  const submission = getSubmissionForActor(req.params.id, req.user);
  if (!submission) {
    return res.status(404).json({ error: "Submission not found." });
  }
  return res.json({ submission });
});

app.patch("/api/admin/submissions/:id/approve", requireAdmin, (req, res) => {
  try {
    const submission = approveSubmission({
      submissionId: req.params.id,
      adminUser: req.user,
    });
    return res.json({
      message: "Submission approved and applied.",
      submission: {
        ...submission,
        diff: buildSubmissionDiff(submission.baseSnapshot || {}, submission.snapshot || {}),
      },
    });
  } catch (error) {
    return res.status(Number(error.statusCode) || 400).json({ error: error.message || "Could not approve submission." });
  }
});

app.patch("/api/admin/submissions/:id/reject", requireAdmin, (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  try {
    const submission = rejectSubmission({
      submissionId: req.params.id,
      adminUser: req.user,
      reason,
    });
    return res.json({
      message: "Submission rejected.",
      submission: {
        ...submission,
        diff: buildSubmissionDiff(submission.baseSnapshot || {}, submission.snapshot || {}),
      },
    });
  } catch (error) {
    return res.status(Number(error.statusCode) || 400).json({ error: error.message || "Could not reject submission." });
  }
});

app.get("/api/admin/activity", requireAdmin, (req, res) => {
  const summary = getAdminPeopleAndActionSummary();
  const recent = listRecentRoleActivities(["vendor", "user"], req.query.limit || 50);
  return res.json({
    summary,
    recent,
  });
});

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
  logActivity({
    actor: req.user,
    actionType: liked ? "like_product" : "unlike_product",
    targetType: "product",
    targetId: productId,
    details: { likesCount },
  });
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

  logActivity({
    actor: req.user,
    actionType: "comment_product",
    targetType: "product",
    targetId: productId,
    details: { commentId: Number(info.lastInsertRowid) },
  });

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

  logActivity({
    actor: req.user,
    actionType: existing ? "cart_update" : "cart_add",
    targetType: "product",
    targetId: productId,
    details: { quantity: nextQuantity },
  });

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
    logActivity({
      actor: req.user,
      actionType: "cart_remove",
      targetType: "product",
      targetId: productId,
      details: {},
    });
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

  logActivity({
    actor: req.user,
    actionType: "cart_update",
    targetType: "product",
    targetId: productId,
    details: { quantity: Math.floor(quantity) },
  });

  return res.json({
    message: "Cart updated.",
    cart: serializeCart(req.user.id),
  });
});

app.delete("/api/cart/items/:productId", requireUser, (req, res) => {
  const productId = String(req.params.productId || "").trim();
  db.prepare("delete from cart_items where user_id = ? and product_id = ?")
    .run(req.user.id, productId);
  logActivity({
    actor: req.user,
    actionType: "cart_remove",
    targetType: "product",
    targetId: productId,
    details: {},
  });
  return res.json({
    message: "Item removed.",
    cart: serializeCart(req.user.id),
  });
});

app.delete("/api/cart", requireUser, (req, res) => {
  db.prepare("delete from cart_items where user_id = ?").run(req.user.id);
  logActivity({
    actor: req.user,
    actionType: "cart_clear",
    targetType: "cart",
    targetId: String(req.user.id),
    details: {},
  });
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
