const express = require("express");
const router = express.Router();
const { readData, writeData, nextId } = require("../utils/db");
const { requireAdmin } = require("../middleware/adminAuth");

const FILE = "orders.json";
const MENU_FILE = "menu.json";
const REVENUE_FILE = "revenue.json";
const VALID_STATUSES = ["pending", "preparing", "delivering", "completed", "cancelled"];
const VALID_PAYMENT_STATUSES = ["unpaid", "paid"];

// Local calendar date (YYYY-MM-DD), not UTC. Using toISOString() here
// would take the UTC date instead, which is a different calendar day
// than Vietnam's for roughly 7 hours around midnight (UTC+7).
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildOrderItems(clientItems) {
  const menuById = new Map(readData(MENU_FILE).map((item) => [Number(item.id), item]));

  return clientItems.map((clientItem) => {
    const id = Number(clientItem.id);
    const quantity = Number(clientItem.quantity);
    const menuItem = menuById.get(id);

    if (!menuItem) {
      throw new Error("Dish not found in the menu");
    }

    if (menuItem.available === false) {
      throw new Error(`${menuItem.name} is not available`);
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("Invalid item quantity");
    }

    return {
      id: menuItem.id,
      name: menuItem.name,
      price: Number(menuItem.price),
      quantity,
    };
  });
}

// GET /api/orders - (admin) view all orders
router.get("/", requireAdmin, (req, res) => {
  const orders = readData(FILE);
  res.json(orders);
});

// GET /api/orders/revenue/today - (admin) today's recorded revenue.
// This reads from revenue.json, NOT from the live orders list, so
// deleting a completed/paid order afterwards does not change it.
router.get("/revenue/today", requireAdmin, (req, res) => {
  const revenue = readData(REVENUE_FILE, "{}");
  const key = todayKey();
  res.json({ date: key, total: revenue[key] || 0 });
});

// GET /api/orders/revenue/history - (admin) the full day -> total map,
// used to draw the "last 7 days" revenue chart without it being
// affected by orders that were deleted after being paid.
router.get("/revenue/history", requireAdmin, (req, res) => {
  res.json(readData(REVENUE_FILE, "{}"));
});

// GET /api/orders/:id - look up a single order by id
// IMPORTANT: this must come AFTER the two /revenue/* routes above,
// otherwise Express would treat "revenue" as an :id value here.
router.get("/:id", (req, res) => {
  const orders = readData(FILE);
  const order = orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

// POST /api/orders - customer places a new order
router.post("/", (req, res) => {
  const { customerName, tableNumber, items } = req.body;

  if (!customerName || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Missing customer name or the cart is empty" });
  }

  let orderItems;
  try {
    orderItems = buildOrderItems(items);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const total = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const orders = readData(FILE);
  const newOrder = {
    id: nextId(orders),
    customerName,
    tableNumber: tableNumber || null,
    items: orderItems,
    total,
    status: "pending",
    paymentStatus: "unpaid",
    revenueRecordedOn: null, // which day's revenue bucket this order's total was added to, if any
    createdAt: new Date().toISOString(),
  };

  orders.push(newOrder);
  writeData(FILE, orders);
  res.status(201).json(newOrder);
});

// PUT /api/orders/:id - (admin) update order kitchen status
router.put("/:id", requireAdmin, (req, res) => {
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Allowed values: ${VALID_STATUSES.join(", ")}`,
    });
  }

  const orders = readData(FILE);
  const index = orders.findIndex((o) => o.id === Number(req.params.id));

  if (index === -1) {
    return res.status(404).json({ error: "Order not found" });
  }

  orders[index].status = status;
  writeData(FILE, orders);
  res.json(orders[index]);
});

// PUT /api/orders/:id/payment - (admin) toggle payment status
// This is the only place that writes to revenue.json:
// - marking "paid" for the first time adds the order's total to
//   TODAY's bucket, and remembers which day it was recorded on.
// - marking "unpaid" (correcting a mistake) subtracts it back from
//   whichever day it was recorded on, so the books stay accurate.
// - toggling paid -> unpaid -> paid again on the SAME order never
//   double-counts, because revenueRecordedOn tracks whether it is
//   currently counted.
router.put("/:id/payment", requireAdmin, (req, res) => {
  const { paymentStatus } = req.body;

  if (!VALID_PAYMENT_STATUSES.includes(paymentStatus)) {
    return res.status(400).json({
      error: `Invalid paymentStatus. Allowed values: ${VALID_PAYMENT_STATUSES.join(", ")}`,
    });
  }

  const orders = readData(FILE);
  const index = orders.findIndex((o) => o.id === Number(req.params.id));

  if (index === -1) {
    return res.status(404).json({ error: "Order not found" });
  }

  const order = orders[index];
  const revenue = readData(REVENUE_FILE, "{}");

  if (paymentStatus === "paid" && !order.revenueRecordedOn) {
    const key = todayKey();
    revenue[key] = (revenue[key] || 0) + Number(order.total);
    order.revenueRecordedOn = key;
    writeData(REVENUE_FILE, revenue);
  } else if (paymentStatus === "unpaid" && order.revenueRecordedOn) {
    const key = order.revenueRecordedOn;
    revenue[key] = Math.max(0, (revenue[key] || 0) - Number(order.total));
    order.revenueRecordedOn = null;
    writeData(REVENUE_FILE, revenue);
  }

  order.paymentStatus = paymentStatus;
  writeData(FILE, orders);
  res.json(order);
});

// DELETE /api/orders/:id - (admin) remove a single order.
// Deliberately does NOT touch revenue.json - a day's recorded
// revenue must survive its orders being deleted.
router.delete("/:id", requireAdmin, (req, res) => {
  const orders = readData(FILE);
  const filtered = orders.filter((o) => o.id !== Number(req.params.id));

  if (filtered.length === orders.length) {
    return res.status(404).json({ error: "Order not found" });
  }

  writeData(FILE, filtered);
  res.json({ message: "Order deleted" });
});

module.exports = router;
