/**
 * NetSuite REST API GET IA — 對齊 netsuite_AI_connector/netsuite_client.js 寫法
 * 憑證用環境變數：NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET, NS_REALM
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

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
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
    console.error('請設定 NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET');
    process.exit(1);
  }

  // 對齊 netsuite_AI_connector：baseUrl 用「小寫」realm
  const baseUrl = `https://${realm.toLowerCase()}.suitetalk.api.netsuite.com/services/rest`;
  const relativeUrl = `/record/v1/inventoryAdjustment/${iaId}?expandSubResources=true`;
  const url = baseUrl + relativeUrl;

  const oauth = OAuth({
    consumer: { key: consumerKey, secret: consumerSecret },
    signature_method: 'HMAC-SHA256',
    hash_function(base_string, key) {
      return crypto.createHmac('sha256', key).update(base_string).digest('base64');
    },
  });
  const token = { key: tokenId, secret: tokenSecret };
  const headers = getHeaders(oauth, token, realm, 'GET', url);

  console.error('GET', url);
  const result = await get(url, headers);
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
