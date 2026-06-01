# 腳本說明

## ns-rest-get-ia-oauth1a.js（建議使用）

用 NetSuite **SuiteTalk REST API** GET 一張 Inventory Adjustment，看完整結構與子資源（含 inventory detail）。  
**寫法對齊** [netsuite_AI_connector/netsuite_client.js](https://github.com/.../netsuite_AI_connector)：baseUrl 用 **小寫** realm（`td3018275`），realm 在 toHeader 後手動插入。

**憑證**：請用環境變數，勿寫入程式或提交。

```bash
export NS_CONSUMER_KEY=...
export NS_CONSUMER_SECRET=...
export NS_TOKEN_ID=...
export NS_TOKEN_SECRET=...
export NS_REALM=TD3018275
node scripts/ns-rest-get-ia-oauth1a.js [iaId]
```

**注意**：  
- baseUrl 必須為 `https://{realm小寫}.suitetalk.api.netsuite.com/services/rest`，否則易 401。  
- Token 須具備 **REST Web Services** 權限。

## ns-rest-post-ia.js（建立 IA 測試）

用 REST **POST** 建立一張 IA，測 API 接受的 payload。

```bash
# 不帶 inventoryDetail（此帳戶 REST 接受，回 204）
export NS_CONSUMER_KEY=... NS_CONSUMER_SECRET=... NS_TOKEN_ID=... NS_TOKEN_SECRET=... NS_REALM=TD3018275
node scripts/ns-rest-post-ia.js

# 帶 inventoryDetail + inventoryStatus（此帳戶回 400：「reconfigure inventory detail」）
node scripts/ns-rest-post-ia.js --with-detail
```

**已測結果（Design By Ming）**：  
- **GET** 一張既有 IA（expandSubResources=true）→ **200**，可看到完整結構含 inventoryDetail.inventoryAssignment.items[].inventoryStatus.id。  
- **POST 不帶 inventoryDetail**（只 item / location / adjustQtyBy / unitCost）→ **204**，IA 建立成功。  
- **POST 帶 inventoryDetail**（inventoryAssignment.items: quantity + inventoryStatus.id）→ **400**，錯誤：「You still need to reconfigure the inventory detail record after changing the quantity.」

## IA 必填欄位（依 SuiteScript、手動打單與 REST 回傳）

REST GET 回傳結構（expandSubResources=true）可對照：

- **Body**：account (id), subsidiary (id), trandate, customForm (id), postingPeriod 等  
- **inventory.items[]**：item (id), location (id), adjustQtyBy, unitCost, **inventoryDetail**  
- **inventoryDetail.inventoryAssignment.items[]**：**inventoryStatus** (id，如 "1" = Good), **quantity**

目前 Cost Variance Wash（SuiteScript）建立 IA 時依下列對應：

| 層級 | 必填 | 說明 |
|------|------|------|
| Body | account, subsidiary, trandate, memo | customform 依帳戶預設 |
| inventory 行 | item, location, adjustqtyby；In 行加 unitcost | 不設 inventorystatus（該欄位不在 IA 的 inventory 子清單） |
| inventorydetail > inventoryassignment | quantity, inventorystatus | 若帳戶強制「請設定此行的 inventory detail」則必填；REST 回傳為 inventoryStatus.id（字串，如 "1"） |
