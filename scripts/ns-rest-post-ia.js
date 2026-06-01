/**
 * NetSuite REST API POST 建立一張 IA — 測試 API 接受的 payload（含 inventoryDetail + inventoryStatus）
 * 對齊 ns-rest-get-ia-oauth1a.js 的 OAuth 寫法（小寫 realm、realm 手動插入）
 * 憑證：NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET, NS_REALM
 * 可選：NS_ACCOUNT_ID, NS_SUBSIDIARY_ID, NS_ITEM_ID, NS_LOCATION_ID, NS_STATUS_ID（預設用 GET 回傳的 Design By Ming 值）
 */
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const https = require('https');

function getHeaders(oauth, token, realm, method, url) {
  const requestData = { url, method };
  const authorization = oauth.authorize(requestData, token);
  const authHeader = oauth.toHeader(authorization);
  let authHeaderValue = authHeader['Authorization'];
  authHeaderValue = authHeaderValue.replace('OAuth ', `OAuth realm="${realm}", `);
  return {
    'Authorization': authHeaderValue,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Prefer': 'return=representation',
  };
}

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const json = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(json, 'utf8') },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, location: res.headers.location });
          } catch (e) {
            resolve({ status: res.statusCode, body: data, location: res.headers.location });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

async function main() {
  const consumerKey = process.env.NS_CONSUMER_KEY;
  const consumerSecret = process.env.NS_CONSUMER_SECRET;
  const tokenId = process.env.NS_TOKEN_ID;
  const tokenSecret = process.env.NS_TOKEN_SECRET;
  const realm = process.env.NS_REALM || 'TD3018275';
  const accountId = process.env.NS_ACCOUNT_ID || '323';
  const subsidiaryId = process.env.NS_SUBSIDIARY_ID || '21';
  const itemId = process.env.NS_ITEM_ID || '763';
  const locationId = process.env.NS_LOCATION_ID || '218';
  const statusId = process.env.NS_STATUS_ID || '1';

  if (!consumerKey || !consumerSecret || !tokenId || !tokenSecret) {
    console.error('請設定 NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET');
    process.exit(1);
  }

  const baseUrl = `https://${realm.toLowerCase()}.suitetalk.api.netsuite.com/services/rest`;
  const url = baseUrl + '/record/v1/inventoryAdjustment';

  const oauth = OAuth({
    consumer: { key: consumerKey, secret: consumerSecret },
    signature_method: 'HMAC-SHA256',
    hash_function(base_string, key) {
      return crypto.createHmac('sha256', key).update(base_string).digest('base64');
    },
  });
  const token = { key: tokenId, secret: tokenSecret };
  const headers = getHeaders(oauth, token, realm, 'POST', url);

  // 不帶 inventoryDetail：此帳戶 REST 接受，回 204；帶 detail 時 API 回 400「reconfigure inventory detail」
  const withDetail = process.argv.includes('--with-detail');
  const body = {
    account: { id: accountId },
    subsidiary: { id: subsidiaryId },
    tranDate: new Date().toISOString().slice(0, 10),
    memo: 'REST API test IA',
    inventory: {
      items: [
        withDetail
          ? {
              item: { id: itemId },
              location: { id: locationId },
              adjustQtyBy: 1,
              unitCost: 10,
              inventoryDetail: {
                inventoryAssignment: {
                  items: [
                    { quantity: 1, inventoryStatus: { id: statusId } }
                  ]
                }
              }
            }
          : {
              item: { id: itemId },
              location: { id: locationId },
              adjustQtyBy: 1,
              unitCost: 10
            }
      ]
    }
  };

  console.error('POST', url);
  console.error('Body (statusId=%s):', statusId, JSON.stringify(body, null, 2));
  const result = await post(url, headers, body);
  console.error('Status:', result.status);
  if (result.location) console.error('Location:', result.location);
  console.log(JSON.stringify(result.body, null, 2));
  process.exit(result.status >= 200 && result.status < 300 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
