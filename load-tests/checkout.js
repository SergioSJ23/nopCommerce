/**
 * k6 Load Test — nopCommerce Checkout Flow
 *
 * Generates traffic that exercises all 3 custom OTel metrics:
 *   • checkout.cart_age_seconds   — how long the cart existed before checkout
 *   • checkout.provider_outcome     — payment success / failure counter
 *   • checkout.db_write_duration  — time spent saving the order to the DB
 *
 * ── Setup ──────────────────────────────────────────────────────────────────
 *   k6 run load-tests/checkout.js
 *
 * ── Environment variables ──────────────────────────────────────────────────
 *   BASE_URL     nopCommerce base URL          (default: http://localhost)
 *   PRODUCT_ID   Product to add to cart        (default: 3)
 *   VUS_HUMAN    Concurrent human VUs          (default: 1)
 *   VUS_BOT      Concurrent bot VUs            (default: 1)
 *   DURATION     How long to run               (default: 5m)
 *   VU_PASSWORD  Password for test accounts    (default: LoadTest@123)
 *   DEBUG        Set to "1" to print OPC step responses (default: off)
 *
 * ── Finding the right PRODUCT_ID ──────────────────────────────────────────
 *   Admin → Catalog → Products → pick any simple in-stock product
 *   Copy ID from URL: /Admin/Product/Edit/{ID}
 */

import http from 'k6/http';
import { sleep, check } from 'k6';

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL    = (__ENV.BASE_URL   || 'http://localhost').replace(/\/$/, '');
const PRODUCT_ID  = __ENV.PRODUCT_ID  || '3'; // Lenovo IdeaCentre — simple product, no required attributes
const VU_PASSWORD = __ENV.VU_PASSWORD || 'LoadTest@123';
const VUS_HUMAN   = parseInt(__ENV.VUS_HUMAN || '3');
const VUS_BOT     = parseInt(__ENV.VUS_BOT   || '3');
const DURATION    = __ENV.DURATION    || '5m';
const DEBUG       = __ENV.DEBUG === '1';

// ── Scenario options ─────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    human_checkout: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s',   target: VUS_HUMAN },
        { duration: '4m',   target: VUS_HUMAN },
        { duration: '30s',  target: 0 },
      ],
      exec: 'humanCheckout',
      gracefulRampDown: '30s',
    },
    bot_checkout: {
      executor: 'constant-vus',
      vus: VUS_BOT,
      duration: '5m',
      exec: 'botCheckout',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<8000'],
    http_req_failed:   ['rate<0.7'],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getToken(res) {
  return res.html().find('input[name="__RequestVerificationToken"]').first().attr('value') || '';
}

function vuEmail() {
  return `loadtest_vu${__VU}@test.invalid`;
}

function log(msg) {
  if (DEBUG) console.log(`[VU${__VU}] ${msg}`);
}

function logError(step, body) {
  // Always log errors regardless of DEBUG flag
  const preview = typeof body === 'string' ? body.substring(0, 300) : JSON.stringify(body);
  console.error(`[VU${__VU}] ✗ ${step}: ${preview}`);
}

/**
 * Parse OPC JSON response. Returns the parsed object,
 * or null if the response contains {error: 1, ...}.
 */
function opcResult(res, step) {
  let data;
  try { data = res.json(); } catch (_) {
    logError(step, `non-JSON response (status ${res.status}): ${res.body.substring(0, 200)}`);
    return null;
  }
  if (data && (data.error === 1 || data.error === '1')) {
    logError(step, data);
    return null;
  }
  log(`${step} OK → goto_section="${data?.goto_section}"`);
  return data;
}

// ── Account management ───────────────────────────────────────────────────────

let sessionReady = false;

function ensureSession() {
  if (sessionReady) return true;

  const email    = vuEmail();
  const password = VU_PASSWORD;

  // Try login first (account may already exist)
  const loginPage = http.get(`${BASE_URL}/login`);
  if (loginPage.status !== 200) { console.error(`[VU${__VU}] /login returned ${loginPage.status}`); return false; }

  const loginRes = http.post(`${BASE_URL}/login?returnUrl=%2F`, {
    __RequestVerificationToken: getToken(loginPage),
    Email: email, Password: password, RememberMe: 'false',
  });

  if (!loginRes.url.includes('/login')) {
    log('login OK (existing account)');
    sessionReady = true;
    return true;
  }

  // Register
  const registerPage = http.get(`${BASE_URL}/register`);
  if (registerPage.status !== 200) return false;

  const regRes = http.post(`${BASE_URL}/register`, {
    __RequestVerificationToken: getToken(registerPage),
    Gender: 'M', FirstName: 'Load', LastName: `Test${__VU}`,
    Email: email, Password: password, ConfirmPassword: password,
    'register-button': '',
  });

  if (regRes.url.includes('/register') && !regRes.url.includes('registerresult')) {
    logError('register', `still on /register after POST — url: ${regRes.url}`);
    return false;
  }

  // Login after registration
  const loginPage2 = http.get(`${BASE_URL}/login`);
  const loginRes2  = http.post(`${BASE_URL}/login?returnUrl=%2F`, {
    __RequestVerificationToken: getToken(loginPage2),
    Email: email, Password: password, RememberMe: 'false',
  });

  sessionReady = !loginRes2.url.includes('/login');
  if (!sessionReady) { logError('login-after-register', `url: ${loginRes2.url}`); }
  return sessionReady;
}

// ── Core checkout flow ───────────────────────────────────────────────────────

function doCheckout(cartWaitSeconds) {
  if (!ensureSession()) { sleep(5); return; }

  // 1. Load a page to get a valid antiforgery cookie + token for the authenticated session.
  //    After login, ASP.NET Core issues a new antiforgery cookie — we must do at least one
  //    GET before any POST, otherwise the cookie is absent and every POST returns 400.
  const browsePage = http.get(BASE_URL);
  if (browsePage.url.includes('/login')) {
    log('session expired on home page, re-logging in');
    sessionReady = false;
    ensureSession();
    return;
  }
  // Extract the antiforgery token from any form on the page (product add-to-cart forms work)
  const pageToken = getToken(browsePage);

  // 2. Add to cart (include both the cookie — now in jar — and the form token)
  const addRes = http.post(
    `${BASE_URL}/addproducttocart/details/${PRODUCT_ID}/1`,
    {
      [`addtocart_${PRODUCT_ID}_EnteredQuantity`]: '1',
      __RequestVerificationToken: pageToken,
    },
    { headers: { 'X-Requested-With': 'XMLHttpRequest' } }
  );
  if (!check(addRes, { 'add to cart': r => r.status === 200 })) {
    logError('add_to_cart', `status=${addRes.status} body=${addRes.body.substring(0,200)}`);
    return;
  }

  // 3. GET /cart — submit required checkout attributes (e.g. "Gift wrapping")
  //    nopCommerce validates these at order placement; they must be saved before checkout.
  const cartPage = http.get(`${BASE_URL}/cart`);
  const cartToken = getToken(cartPage);

  // Extract every checkout_attribute_N and pick the first value for each.
  // Handles both radio/checkbox inputs AND dropdown selects.
  const checkoutAttrs = { __RequestVerificationToken: cartToken, updatecart: '' };
  let attrMatch;

  // Radio / checkbox: <input ... name="checkout_attribute_N" ... value="M" ...>
  const radioRe = /name="(checkout_attribute_\d+)"[^>]*value="(\d+)"/g;
  while ((attrMatch = radioRe.exec(cartPage.body)) !== null) {
    if (!checkoutAttrs[attrMatch[1]]) checkoutAttrs[attrMatch[1]] = attrMatch[2];
  }

  // Dropdown (select): <select name="checkout_attribute_N">...<option value="M">...
  const selectRe = /<select[^>]*name="(checkout_attribute_\d+)"[^>]*>([\s\S]*?)<\/select>/g;
  while ((attrMatch = selectRe.exec(cartPage.body)) !== null) {
    const name = attrMatch[1];
    if (checkoutAttrs[name]) continue; // already captured by radio pass
    const optMatch = attrMatch[2].match(/<option[^>]+value="([1-9]\d*)"/); // first non-zero option
    if (optMatch) checkoutAttrs[name] = optMatch[1];
  }

  http.post(`${BASE_URL}/cart`, checkoutAttrs);
  log(`checkout attributes submitted: ${JSON.stringify(checkoutAttrs)}`);

  // Simulate cart age
  if (cartWaitSeconds > 0) sleep(cartWaitSeconds);

  // 2. Load checkout page (validates session + gets antiforgery token)
  const checkoutPage = http.get(`${BASE_URL}/checkout`);

  if (checkoutPage.url.includes('/login')) {
    log('session expired, re-logging in');
    sessionReady = false;
    ensureSession();
    return;
  }
  if (checkoutPage.status !== 200) {
    logError('checkout_page', `status=${checkoutPage.status} url=${checkoutPage.url}`);
    return;
  }

  const token = getToken(checkoutPage);
  if (!token) {
    logError('checkout_page', 'no antiforgery token found in page');
    return;
  }

  const opcHeaders = { headers: { 'X-Requested-With': 'XMLHttpRequest' } };

  // 3. Billing address
  const billingRes = http.post(`${BASE_URL}/checkout/OpcSaveBilling`, {
    __RequestVerificationToken:        token,
    billingAddressId:                  '0',
    'BillingNewAddress.FirstName':     'Load',
    'BillingNewAddress.LastName':      `Test${__VU}`,
    'BillingNewAddress.Email':         vuEmail(),
    'BillingNewAddress.CountryId':     '1',
    'BillingNewAddress.StateProvinceId': '0',
    'BillingNewAddress.City':          'New York',
    'BillingNewAddress.Address1':      '123 Load Test Ave',
    'BillingNewAddress.ZipPostalCode': '10001',
    'BillingNewAddress.PhoneNumber':   '5551234567',
    ShipToSameAddress:                 'true',
  }, opcHeaders);

  const billingData = opcResult(billingRes, 'OpcSaveBilling');
  if (!billingData) return;

  // 4. Shipping method — extract from billing response (handles any attribute order)
  let shippingMethod = null;
  try {
    const html = billingData?.update_section?.html || '';
    // nopCommerce renders: <input ... name="shippingoption" value="Ground___Shipping.FixedByWeightByTotal" ...>
    // Regex handles name before value OR value before name
    const m = html.match(/name="shippingoption"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*name="shippingoption"/);
    if (m) shippingMethod = m[1] || m[2];
    if (!shippingMethod) {
      // Wider fallback: find any value near "shippingoption" in the HTML
      const m2 = html.match(/shippingoption[^>]+value="([^"]+)"|value="([^"]+)"[^>]+shippingoption/);
      if (m2) shippingMethod = m2[1] || m2[2];
    }
  } catch (_) {}

  if (!shippingMethod) {
    // Log the billing response so we can see the actual shipping method names
    console.error(`[VU${__VU}] Could not extract shipping method. Billing HTML preview:`);
    console.error(String(billingData?.update_section?.html || '(empty)').substring(0, 500));
    return; // stop here so the error is visible — do NOT guess a wrong method
  }

  log(`shipping method: ${shippingMethod}`);

  const shippingRes = http.post(`${BASE_URL}/checkout/OpcSaveShippingMethod`, {
    __RequestVerificationToken: token,
    shippingoption: shippingMethod,
  }, opcHeaders);

  const shippingData = opcResult(shippingRes, 'OpcSaveShippingMethod');
  if (!shippingData) return;

  // 5. Payment method
  const paymentMethodRes = http.post(`${BASE_URL}/checkout/OpcSavePaymentMethod`, {
    __RequestVerificationToken: token,
    paymentmethod:   'Payments.Manual',
    UseRewardPoints: 'false',
  }, opcHeaders);

  const paymentMethodData = opcResult(paymentMethodRes, 'OpcSavePaymentMethod');
  if (!paymentMethodData) return;

  // 6. Payment info — Manual Payment requires card fields (validated server-side)
  const paymentInfoRes = http.post(`${BASE_URL}/checkout/OpcSavePaymentInfo`, {
    __RequestVerificationToken: token,
    CardholderName: 'Load Test',
    CardNumber:     '4111111111111111', // Visa test number — passes IsCreditCard()
    CardCode:       '123',
    ExpireMonth:    '12',
    ExpireYear:     '2030',
  }, opcHeaders);

  const paymentInfoData = opcResult(paymentInfoRes, 'OpcSavePaymentInfo');
  if (!paymentInfoData) return;
  if (!paymentInfoData.goto_section) {
    logError('OpcSavePaymentInfo', 'validation failed (no goto_section) — card fields rejected');
    return;
  }

  // 7. Confirm order — triggers PlaceOrderAsync → our OTel metrics fire here
  const confirmRes = http.post(`${BASE_URL}/checkout/OpcConfirmOrder`, {
    __RequestVerificationToken: token,
  }, opcHeaders);

  const confirmData = opcResult(confirmRes, 'OpcConfirmOrder');
  // Success → {success:1}  |  Payment failure → {update_section, goto_section:"confirm_order"} (no error:1)
  const placed = confirmData?.success === 1;
  if (!placed && confirmData && !confirmData.error) {
    logError('OpcConfirmOrder', `payment declined (goto_section="${confirmData.goto_section}")`);
  }
  check(confirmRes, { 'order placed': () => placed });

  sleep(1);
}

// ── Exported scenario functions ──────────────────────────────────────────────

export function humanCheckout() {
  doCheckout(25 + Math.random() * 35); // 25–60s → human cart age
}

export function botCheckout() {
  doCheckout(Math.random() * 10); // 0–10s → bot cart age
}

// ── Setup ────────────────────────────────────────────────────────────────────

export function setup() {
  const res = http.get(BASE_URL);
  if (res.status !== 200) {
    throw new Error(`nopCommerce not reachable at ${BASE_URL} (HTTP ${res.status})`);
  }
  console.log(`✓ BASE_URL=${BASE_URL}  PRODUCT_ID=${PRODUCT_ID}`);
  console.log(`✓ VUS_HUMAN=${VUS_HUMAN}  VUS_BOT=${VUS_BOT}  DURATION=${DURATION}`);
  console.log(`  Tip: run with -e DEBUG=1 to print each OPC step response`);
}
