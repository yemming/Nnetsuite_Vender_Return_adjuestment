# Cost Variance Wash（供應商退貨價差回滾平均成本）使用手冊

> 兄弟版本：這份文件是交付客戶用的「可落地說明」，讓財會/倉儲/系統三方對同一件事講同一句話：  
> **供應商退貨（Vendor Return）產生的價差，不要留在差異科目，而是要回滾到存貨平均成本（Group Average）裡。**

---

## 1. 需求背景（為什麼要做）

在 NetSuite 標準流程中，供應商退貨常見會出現「退貨金額（VRA 單價）」與「出庫成本（當下平均成本）」不一致。

- **標準行為**：系統會把差額放在某個「差異/調整」相關科目（例如 Vendor Return Variance / Cost of Sales Adjustment），導致財務報表出現一條「客戶不想看到」的差異。
- **本客製目標**：把此差額**改為回滾到 Inventory Asset（存貨資產）**，使存貨平均成本（Group Average / Location Average）重新計算到期望的方向，並避免差異科目累積。

---

## 2. 客製方案概念（核心做法）

### 2.1 核心策略：虛擬倉 + Inventory Adjustment 的「一進一出」

本客製在供應商退貨的 **Item Fulfillment（IF）出貨完成（Shipped）**後，自動建立一張 **Inventory Adjustment（IA）**，在指定的「虛退倉（Dummy Location）」做一組「+1 / -1」的調整：

- **Line A（In）**：+1 單位，指定 `unitcost = washUnitCost`
- **Line B（Out）**：-1 單位，不指定 unitcost（由系統用平均成本出庫）

此組合的目的不是移動存貨數量（最終數量淨變動為 0），而是讓 **Inventory Asset 的金額淨變動**等於我們要回滾的價差，藉此讓平均成本重新計算。

### 2.2 價差回滾的數學（一定要講清楚，財會才買單）

定義：
- `currentAvgCost`：該 item 在該 location 的當下平均成本（每單位）
- `vraRate`：Vendor Return Authorization（VRA）該行的退貨單價（每單位）
- `quantity`：本次退貨數量（IF 行的 quantity）

要回滾到存貨的**總價差金額**：

\[
varianceTotal = (vraRate - currentAvgCost) \times quantity
\]

IA 的兩行對 Inventory Asset 的**淨影響**：

\[
\Delta InventoryAsset = washUnitCost - currentAvgCost
\]

我們要讓：

\[
washUnitCost - currentAvgCost = varianceTotal
\Rightarrow washUnitCost = currentAvgCost + varianceTotal
\]

因此這張 IA 會把差額**從「調整科目」移回「Inventory Asset」**，並使平均成本在 Group Average 規則下重新滾動。

---

## 3. 流程說明（觸發點與資料流）

### 3.1 觸發條件（User Event：afterSubmit）

此客製腳本 `CostVarianceWash_UE.js` 在 **Item Fulfillment** 的 `afterSubmit` 觸發，並符合以下條件才會執行：

- **來源單據**：`createdfrom` 必須是 **Vendor Return Authorization（VRA）**
- **狀態**：Item Fulfillment 必須是 **Shipped**
- **事件類型**：排除 DELETE

### 3.2 取價（重要：不要用 IF 的 rate）

因為 Item Fulfillment 行上的 `rate` 在部分表單/流程下可能為空或不可靠，本客製使用：

- 讀取 VRA（createdfrom）
- 以 `lineuniquekey` 將 VRA 行的 `rate` 映射成 `lineKey -> vraRate`
- 在 IF 逐行處理時，使用同一個 `lineuniquekey` 取回正確的 `vraRate`

### 3.3 成本與庫存量來源

腳本透過 Item Search 取得：
- `locationaveragecost`
- `locationquantityonhand`

用於計算 `currentAvgCost` 與 `totalQtyOnHand`（若 qty on hand <= 0 則跳過該行，不做回滾）。

---

## 4. 會計科目影響（動到哪些科目？哪裡會平？）

### 4.1 會動到的主要科目

此客製建立的 IA 會影響（依 NetSuite 設定可能略有差異，但邏輯一致）：

- **Inventory Asset（存貨資產）**：一定會動（因為 IA 在存貨資產做金額重估）
- **Adjustment Account（調整科目）**：由 IA Header 的 `Adjustment Account` 決定  
  本專案以腳本參數 `custscript_cvw_adjustment_account` 指定（例如「供應商進貨差價」）

> 重要：此客製的設計目標，是讓原本因供應商退貨落在差異科目的金額，被 IA 轉回 Inventory Asset。

### 4.2 哪裡會「平」？

**Inventory Adjustment（IA）本身一定平**：  
GL Impact 會呈現「Inventory Asset」與「Adjustment Account」成對出現（借貸總額相等）。

例如（示意）：
- Adjustment Account：Credit 89.06
- Inventory Asset：Debit 89.06（可能拆成兩行顯示，取決於系統出庫/入庫分錄）

### 4.3 哪裡可能「不會照你預期平」（風險與限制）

以下情境會讓回滾不如預期或直接跳過：

- **IF 行找不到對應的 VRA rate**：會跳過該行（避免算錯）
- **該 item/location 的 on hand <= 0**：跳過（避免平均成本回滾沒有基底）
- **Item Search 撈不到 locationaveragecost/locationquantityonhand**：跳過（需調整搜尋或欄位 join）
- **帳務期間鎖定/權限不足**：IA save 會失敗（但腳本會 try/catch，避免卡住交易）

---

## 5. 安裝與設定（交付給客戶照做）

### 5.1 部署方式（SuiteCloud CLI）

在專案根目錄執行：

```bash
suitecloud project:deploy
```

成功後會上傳 `FileCabinet/SuiteScripts/CostVarianceWash_UE.js`。

### 5.2 Script / Deployment 設定

Script：`CostVarianceWash_UE`  
Applies To：Item Fulfillment  
Event：afterSubmit

### 5.3 必要參數（Deployment Parameters）

必填：
- **`custscript_cvw_adjustment_account`**：IA Header 的 `Adjustment Account`（例：供應商進貨差價）
- **`custscript_cvw_dummy_location`**：虛退倉（Dummy Location）的 internal id

> Inventory Status：本版本不硬指定 `inventorystatus`，僅在需要 Inventory Detail 時補上 assignment quantity，讓系統自行帶預設狀態。

---

## 6. 操作方式（使用者怎麼用）

### 6.1 正常操作流程

1. 建立 Vendor Return Authorization（VRA），填入退貨單價（rate）
2. 由 VRA 建立 Item Fulfillment（IF）
3. 將 IF 完成出貨（Shipped）
4. 系統自動建立一張 Inventory Adjustment（IA）
   - Memo 會是：`Cost Variance Wash for IF #<IF internal id>`
5. 會計可在 IA 的 GL Impact 檢查：
   - Inventory Asset 是否被調整
   - Adjustment Account 是否出現相反方向金額（用來把差額移回存貨）

### 6.2 防重複機制（很重要）

同一張 IF 只會產生**一次** IA。  
若使用者 Edit / Re-save IF，不會再產生第二張 IA，以避免重複回滾造成成本失真。

若需要重跑（僅限測試/更正）：
- 刪除該 IF 對應的 IA，或修改 IA memo（不要含該前綴）
- 再對 IF 進行一次 Save 觸發腳本

---

## 7. 常見問題與排錯（FAQ）

### Q1：為什麼出現「Please configure the inventory detail for this line」？
代表該 item/location 需要 Inventory Detail（可能有狀態/批號/序號要求）。  
本版本已改為「best effort」：若有 subrecord，會寫入 assignment quantity；若仍報錯，通常是帳上還有更嚴格的規則（例如必填 status/lot/serial）。

### Q2：為什麼 IA 看起來沒有把價差洗回去？
常見原因：
- IF 行 rate 不可靠（本客製已改用 VRA line rate）
- VRA 行無法用 lineuniquekey 對應（需確認流程是否真的由同一張 VRA 建 IF）
- Item Search 取不到 locationaveragecost

### Q3：為什麼沒有新增 IA，而是看起來「只用舊的」？
因為防重複機制會偵測到同一 IF 已經有 IA（以 memo 前綴判斷），因此後續不會再開新 IA。

---

## 8. 程式設計摘要（給系統維運/顧問）

### 8.1 檔案位置

- `FileCabinet/SuiteScripts/CostVarianceWash_UE.js`

### 8.2 主要函式

- `afterSubmit(scriptContext)`：主流程與守門條件
- `getInventoryData(itemId, locationId)`：取得 location avg cost 與 qty on hand
- `createInventoryAdjustment(lines, accountId, ifId, dummyLocationId, subsidiaryId)`：建立 IA +1/-1 行並寫入 inventory detail（best effort）
- `hasExistingAdjustmentForIF(ifId)`：防重複（以 memo 前綴搜尋）

### 8.3 安全性與治理單位考量

- 使用 try/catch 避免阻斷交易
- 針對 item/location 成本查詢做 cache（減少重複 search）
- 同一 IF 僅允許建立一次 IA（避免重複影響成本）

---

## 9. 交付備註（建議客戶驗收清單）

建議客戶用 1～2 個 item 做驗收：
- 設定明顯的平均成本與退貨單價差異（例如 avg 9.225、退貨價 10）
- 完成 VRA → IF（Shipped）
- 確認 IA 生成
- 對照：
  - IA 的 GL Impact：Inventory Asset 與 Adjustment Account 是否成對
  - 該 item/location 的 Average Cost 是否有往預期方向移動

---

（完）

