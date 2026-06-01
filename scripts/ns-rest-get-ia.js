/**
 * NetSuite REST API：GET 一張 Inventory Adjustment，看完整結構與必填欄位
 * 憑證請用環境變數，勿寫入程式或提交到版控。
 *
 * 使用：NS_CONSUMER_KEY=... NS_CONSUMER_SECRET=... NS_TOKEN_ID=... NS_TOKEN_SECRET=... NS_REALM=... node scripts/ns-rest-get-ia.js [iaId]
 * 或：先 cp .env.example .env 並填入，再 node -r dotenv/config scripts/ns-rest-get-ia.js [iaId]
 */

const crypto = require('crypto');
const https = require('https');

function rfc3986Encode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function buildOAuthHeader(method, url, consumerKey, consumerSecret, tokenId, tokenSecret, realm) {
  const u = new URL(url);
  const baseUrl = u.origin + u.pathname;
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_token: tokenId,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };
  u.searchParams.forEach((v, k) => { params[k] = v; });
  const sortedKeys = Object.keys(params).sort();
  const paramStr = sortedKeys.map(k => `${rfc3986Encode(k)}=${rfc3986Encode(params[k])}`).join('&');
  const baseString = `${method}&${rfc3986Encode(baseUrl)}&${rfc3986Encode(paramStr)}`;
  const signingKey = `${consumerSecret}&${tokenSecret}`;
  const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');
  params.oauth_signature = signature;
  const headerKeys = ['realm', ...sortedKeys, 'oauth_signature'];
  const headerParams = { realm, ...params };
  const authParts = headerKeys.map(k => {
    const val = headerParams[k] || params[k];
    return `${k === 'realm' ? 'realm' : k}="${k === 'oauth_signature' ? rfc3986Encode(val) : rfc3986Encode(val)}"`;
  });
  return 'OAuth ' + authParts.join(', ');
}

function get(url, options) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': options.authHeader,
          'Accept': 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = body ? JSON.parse(body) : null;
            resolve({ status: res.statusCode, headers: res.headers, body: j });
          } catch (e) {
            resolve({ status: res.statusCode, body });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const consumerKey = process.env.NS_CONSUMER_KEY;
  const consumerSecret = process.env.NS_CONSUMER_SECRET;
  const tokenId = process.env.NS_TOKEN_ID;
  const tokenSecret = process.env.NS_TOKEN_SECRET;
  const realm = process.env.NS_REALM || 'TD3018275';
  const iaId = process.argv[2] || '28017';

  if (!consumerKey || !consumerSecret || !tokenId || !tokenSecret) {
    console.error('請設定 NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET（可選 NS_REALM）');
    process.exit(1);
  }

  const baseUrl = `https://${realm}.suitetalk.api.netsuite.com/services/rest/record/v1`;
  const url = `${baseUrl}/inventoryAdjustment/${iaId}?expandSubResources=true`;
  const method = 'GET';
  const authHeader = buildOAuthHeader(method, url, consumerKey, consumerSecret, tokenId, tokenSecret, realm);

  console.error('GET', url);
  const result = await get(url, { authHeader });
  console.error('Status:', result.status);
  if (result.status !== 200) {
    console.error('Response:', JSON.stringify(result.body, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result.body, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
