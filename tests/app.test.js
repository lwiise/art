const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const dbPath = path.join(os.tmpdir(), `fnn-art-test-${process.pid}-${Date.now()}.db`);
process.env.APP_DB_PATH = dbPath;
process.env.SESSION_SECRET = "test-session-secret";

const { app } = require("../src/server");
const { db, createUser } = require("../src/db");

let server;
let baseUrl;

function makeProduct(index, overrides = {}) {
  return {
    id: `test-product-${index}`,
    name: `Test Product ${index}`,
    gallery_type: "art",
    category: "Artwork",
    status: "active",
    sort_order: index,
    artist_name: `Artist ${index}`,
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
    material: "Oil",
    dimensions: "10 x 10",
    store_name: "",
    store_lng: null,
    store_lat: null,
    medium: "Oil",
    period: "",
    era: "",
    year: 2000,
    rating: 4.5,
    rating_count: "1",
    base_price: 100,
    owner_user_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function setProducts(products) {
  const row = db.prepare("select sections_json from site_state where id = 1").get();
  const sectionsJson = row?.sections_json || "{}";
  db.prepare(
    `update site_state
     set sections_json = ?, products_json = ?, updated_at = datetime('now'), updated_by = null
     where id = 1`
  ).run(sectionsJson, JSON.stringify(products));
}

function clearRuntimeTables() {
  db.prepare("delete from likes").run();
  db.prepare("delete from comments").run();
  db.prepare("delete from cart_items").run();
  db.prepare("delete from edits").run();
  db.prepare("delete from activity_log").run();
  db.prepare("delete from password_reset_tokens").run();
  db.prepare("delete from product_submissions").run();
}

function createClient() {
  let cookie = "";

  async function request(method, route, body) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      cookie = setCookie.split(";")[0];
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    return {
      status: response.status,
      body: payload,
      headers: response.headers,
    };
  }

  return {
    get: (route) => request("GET", route),
    post: (route, body) => request("POST", route, body),
    patch: (route, body) => request("PATCH", route, body),
    delete: (route) => request("DELETE", route),
  };
}

async function loginAdmin(client) {
  const res = await client.post("/api/auth/signin", {
    email: "admin@example.com",
    password: "Admin123!",
  });
  assert.equal(res.status, 200);
}

async function signupUser(client, suffix) {
  const res = await client.post("/api/auth/user/signup", {
    name: `User ${suffix}`,
    email: `user-${suffix}@example.com`,
    password: "User12345!",
  });
  assert.equal(res.status, 201);
  return res.body.user;
}

async function signupVendor(client, suffix) {
  const res = await client.post("/api/auth/signup", {
    name: `Vendor ${suffix}`,
    email: `vendor-${suffix}@example.com`,
    password: "Vendor12345!",
  });
  assert.equal(res.status, 201);
  return res.body.user;
}

function objectContainsKey(value, targetKey) {
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, targetKey)) return true;
  if (Array.isArray(value)) return value.some((item) => objectContainsKey(item, targetKey));
  return Object.values(value).some((item) => objectContainsKey(item, targetKey));
}

test.before(async () => {
  server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  db.close();
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
});

test("admin dashboard counts endpoint returns accurate users/vendors totals", async () => {
  clearRuntimeTables();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  createUser({
    name: `Count User ${suffix}`,
    email: `count-user-${suffix}@example.com`,
    password: "User12345!",
    role: "user",
  });
  createUser({
    name: `Count Vendor ${suffix}`,
    email: `count-vendor-${suffix}@example.com`,
    password: "Vendor12345!",
    role: "vendor",
  });

  const expected = db.prepare(
    `select
      sum(case when role = 'user' then 1 else 0 end) as users_count,
      sum(case when role = 'vendor' then 1 else 0 end) as vendors_count
     from users`
  ).get();

  const admin = createClient();
  await loginAdmin(admin);

  const res = await admin.get("/api/admin/dashboard-counts");
  assert.equal(res.status, 200);
  assert.equal(Number(res.body.usersCount), Number(expected.users_count));
  assert.equal(Number(res.body.vendorsCount), Number(expected.vendors_count));
});

test("admin can list users and vendors with pagination, search, and sorting", async () => {
  clearRuntimeTables();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  createUser({
    name: `List User ${suffix}`,
    email: `list-user-${suffix}@example.com`,
    password: "User12345!",
    role: "user",
  });
  createUser({
    name: `List Vendor ${suffix}`,
    email: `list-vendor-${suffix}@example.com`,
    password: "Vendor12345!",
    role: "vendor",
  });

  const admin = createClient();
  await loginAdmin(admin);

  const usersRes = await admin.get(`/api/admin/users?search=${encodeURIComponent(`list-user-${suffix}`)}&sort_by=email&sort_dir=asc&page_size=10`);
  assert.equal(usersRes.status, 200);
  assert.equal(Array.isArray(usersRes.body.items), true);
  assert.equal(usersRes.body.items.length >= 1, true);
  assert.equal(usersRes.body.items.every((item) => item.role === "user"), true);
  assert.equal(Number(usersRes.body.paging.total) >= 1, true);

  const vendorsRes = await admin.get(`/api/admin/vendors?search=${encodeURIComponent(`list-vendor-${suffix}`)}&sort_by=products_count&sort_dir=desc&page_size=10`);
  assert.equal(vendorsRes.status, 200);
  assert.equal(Array.isArray(vendorsRes.body.items), true);
  assert.equal(vendorsRes.body.items.length >= 1, true);
  assert.equal(vendorsRes.body.items.every((item) => item.role === "vendor"), true);
  assert.equal(Number(vendorsRes.body.paging.total) >= 1, true);
});

test("admin user detail endpoint returns aggregated likes/comments/cart activity", async () => {
  clearRuntimeTables();
  const product = makeProduct(301, { status: "active" });
  setProducts([product]);

  const userClient = createClient();
  const user = await signupUser(userClient, `activity-${Date.now()}`);

  const likeRes = await userClient.post(`/api/products/${encodeURIComponent(product.id)}/like`, {});
  assert.equal(likeRes.status, 200);

  const commentRes = await userClient.post(`/api/products/${encodeURIComponent(product.id)}/comments`, {
    content: "Activity test comment",
  });
  assert.equal(commentRes.status, 201);

  const cartRes = await userClient.post("/api/cart/items", {
    productId: product.id,
    quantity: 2,
  });
  assert.equal(cartRes.status, 201);

  const admin = createClient();
  await loginAdmin(admin);

  const detail = await admin.get(`/api/admin/users/${user.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.user.id, user.id);
  assert.equal(Array.isArray(detail.body.activity.likes), true);
  assert.equal(Array.isArray(detail.body.activity.comments), true);
  assert.equal(Array.isArray(detail.body.activity.cart.items), true);
  assert.equal(detail.body.activity.likes.length, 1);
  assert.equal(detail.body.activity.comments.length, 1);
  assert.equal(detail.body.activity.cart.items.length, 1);
  assert.equal(detail.body.activity.cart.items[0].quantity, 2);
});

test("product submissions store complete snapshot and support approve/reject review workflow", async () => {
  clearRuntimeTables();
  setProducts([]);

  const vendorClient = createClient();
  const vendor = await signupVendor(vendorClient, `submission-${Date.now()}`);

  const submissionPayload = {
    product_changes: [
      {
        id: `submission-product-${Date.now()}`,
        name: "Submission Product",
        gallery_type: "art",
        category: "Artwork",
        status: "active",
        sort_order: 11,
        material: "Oil",
        dimensions: "70 x 50",
        base_price: 500,
        attributes: { frame: "oak", finish: "matte" },
        variants: [{ size: "L", sku: "SUB-L", price: 650 }],
        inventory: 9,
      },
    ],
  };

  const createSubmission = await vendorClient.post("/api/submissions", {
    title: "Vendor submission create",
    description: "Please approve.",
    payload: submissionPayload,
  });
  assert.equal(createSubmission.status, 201);
  assert.equal(Array.isArray(createSubmission.body.submissions), true);
  assert.equal(createSubmission.body.submissions.length, 1);
  const firstSubmission = createSubmission.body.submissions[0];

  const admin = createClient();
  await loginAdmin(admin);

  const firstDetail = await admin.get(`/api/admin/submissions/${firstSubmission.id}`);
  assert.equal(firstDetail.status, 200);
  assert.equal(firstDetail.body.submission.vendorId, vendor.id);
  assert.equal(firstDetail.body.submission.snapshot.name, "Submission Product");
  assert.equal(firstDetail.body.submission.snapshot.extra_fields.inventory, 9);
  assert.equal(firstDetail.body.submission.snapshot.extra_fields.attributes.frame, "oak");
  assert.equal(Array.isArray(firstDetail.body.submission.snapshot.extra_fields.variants), true);

  const rejectWithoutReason = await admin.patch(`/api/admin/submissions/${firstSubmission.id}/reject`, {});
  assert.equal(rejectWithoutReason.status, 400);

  const rejected = await admin.patch(`/api/admin/submissions/${firstSubmission.id}/reject`, {
    reason: "Image quality is too low.",
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.submission.status, "rejected");
  assert.equal(rejected.body.submission.rejectionReason, "Image quality is too low.");

  const approvedPayload = {
    product_changes: [
      {
        id: `submission-approved-${Date.now()}`,
        name: "Approved Product",
        gallery_type: "designs",
        category: "Decor",
        status: "active",
        sort_order: 12,
        inventory: 4,
      },
    ],
  };
  const secondSubmissionRes = await vendorClient.post("/api/submissions", {
    title: "Second vendor submission",
    description: "Approve this one.",
    payload: approvedPayload,
  });
  assert.equal(secondSubmissionRes.status, 201);
  const secondSubmission = secondSubmissionRes.body.submissions[0];

  const approved = await admin.patch(`/api/admin/submissions/${secondSubmission.id}/approve`, {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.submission.status, "approved");

  const productsAfterApprove = await admin.get(`/api/products?search=${encodeURIComponent("Approved Product")}&pageSize=50`);
  assert.equal(productsAfterApprove.status, 200);
  assert.equal(productsAfterApprove.body.items.some((item) => item.name === "Approved Product"), true);
});

test("admin APIs never expose password hashes", async () => {
  clearRuntimeTables();
  const admin = createClient();
  await loginAdmin(admin);

  const users = await admin.get("/api/admin/users?page_size=10");
  assert.equal(users.status, 200);
  assert.equal(objectContainsKey(users.body, "password_hash"), false);
  assert.equal(objectContainsKey(users.body, "passwordHash"), false);

  const vendors = await admin.get("/api/admin/vendors?page_size=10");
  assert.equal(vendors.status, 200);
  assert.equal(objectContainsKey(vendors.body, "password_hash"), false);
  assert.equal(objectContainsKey(vendors.body, "passwordHash"), false);

  const firstUserId = users.body.items[0] && users.body.items[0].id;
  assert.equal(Boolean(firstUserId), true);
  const userDetail = await admin.get(`/api/admin/users/${firstUserId}`);
  assert.equal(userDetail.status, 200);
  assert.equal(objectContainsKey(userDetail.body, "password_hash"), false);
  assert.equal(objectContainsKey(userDetail.body, "passwordHash"), false);
});

test("admin products API returns full dataset with accurate pagination and counts", async () => {
  clearRuntimeTables();
  const products = [];
  for (let i = 1; i <= 105; i += 1) {
    const status = i > 100 ? "inactive" : "active";
    products.push(makeProduct(i, { status }));
  }
  setProducts(products);

  const admin = createClient();
  await loginAdmin(admin);

  const page1 = await admin.get("/api/products?page=1&pageSize=20");
  assert.equal(page1.status, 200);
  assert.equal(page1.body.paging.total, 105);
  assert.equal(page1.body.items.length, 20);
  assert.equal(page1.body.paging.totalPages, 6);

  const page6 = await admin.get("/api/products?page=6&pageSize=20");
  assert.equal(page6.status, 200);
  assert.equal(page6.body.items.length, 5);

  const inactive = await admin.get("/api/products?status=inactive&pageSize=50");
  assert.equal(inactive.status, 200);
  assert.equal(inactive.body.paging.total, 5);
  assert.equal(inactive.body.items.length, 5);
});

test("likes toggle enforces one like per user/product", async () => {
  clearRuntimeTables();
  const product = makeProduct(1, { status: "active" });
  setProducts([product]);

  const userClient = createClient();
  const user = await signupUser(userClient, `likes-${Date.now()}`);

  const first = await userClient.post(`/api/products/${encodeURIComponent(product.id)}/like`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.liked, true);
  assert.equal(first.body.likesCount, 1);

  const second = await userClient.post(`/api/products/${encodeURIComponent(product.id)}/like`, {});
  assert.equal(second.status, 200);
  assert.equal(second.body.liked, false);
  assert.equal(second.body.likesCount, 0);

  const third = await userClient.post(`/api/products/${encodeURIComponent(product.id)}/like`, {});
  assert.equal(third.status, 200);
  assert.equal(third.body.liked, true);
  assert.equal(third.body.likesCount, 1);

  const likeRow = db
    .prepare("select count(*) as total from likes where user_id = ? and product_id = ?")
    .get(user.id, product.id);
  assert.equal(Number(likeRow.total), 1);
});

test("comments API validates input and rate limits rapid posts", async () => {
  clearRuntimeTables();
  const product = makeProduct(2, { status: "active" });
  setProducts([product]);

  const userClient = createClient();
  await signupUser(userClient, `comments-${Date.now()}`);

  const empty = await userClient.post(`/api/products/${encodeURIComponent(product.id)}/comments`, { content: " " });
  assert.equal(empty.status, 400);

  const longContent = "x".repeat(1201);
  const tooLong = await userClient.post(`/api/products/${encodeURIComponent(product.id)}/comments`, { content: longContent });
  assert.equal(tooLong.status, 400);

  const valid = await userClient.post(`/api/products/${encodeURIComponent(product.id)}/comments`, { content: "Great piece." });
  assert.equal(valid.status, 201);

  const throttled = await userClient.post(`/api/products/${encodeURIComponent(product.id)}/comments`, { content: "Another comment" });
  assert.equal(throttled.status, 429);

  const list = await userClient.get(`/api/products/${encodeURIComponent(product.id)}/comments`);
  assert.equal(list.status, 200);
  assert.equal(Array.isArray(list.body.comments), true);
  assert.equal(list.body.comments.length, 1);
});

test("cart API supports add/update/remove/clear workflow", async () => {
  clearRuntimeTables();
  const products = [
    makeProduct(10, { status: "active" }),
    makeProduct(11, { status: "active" }),
  ];
  setProducts(products);

  const userClient = createClient();
  await signupUser(userClient, `cart-${Date.now()}`);

  const addFirst = await userClient.post("/api/cart/items", {
    productId: products[0].id,
    quantity: 2,
  });
  assert.equal(addFirst.status, 201);
  assert.equal(addFirst.body.cart.totalItems, 2);

  const addAgain = await userClient.post("/api/cart/items", {
    productId: products[0].id,
    quantity: 1,
  });
  assert.equal(addAgain.status, 201);
  assert.equal(addAgain.body.cart.totalItems, 3);

  const updateQty = await userClient.patch(`/api/cart/items/${encodeURIComponent(products[0].id)}`, {
    quantity: 5,
  });
  assert.equal(updateQty.status, 200);
  assert.equal(updateQty.body.cart.totalItems, 5);

  const removeItem = await userClient.delete(`/api/cart/items/${encodeURIComponent(products[0].id)}`);
  assert.equal(removeItem.status, 200);
  assert.equal(removeItem.body.cart.totalItems, 0);

  await userClient.post("/api/cart/items", { productId: products[0].id, quantity: 1 });
  await userClient.post("/api/cart/items", { productId: products[1].id, quantity: 2 });
  const clear = await userClient.delete("/api/cart");
  assert.equal(clear.status, 200);
  assert.equal(clear.body.cart.totalItems, 0);
  assert.equal(clear.body.cart.uniqueItems, 0);
});
