# Cost Variance Wash（供應商退貨價差回滾平均成本）
## 5–6頁上台講解簡報（含講者稿）

> 使用方式：每個「---」是一頁投影片。  
> 「講者稿」是你上台要講的話（可照念、可自由發揮）。

---

## 1｜開場：客戶的痛點（為什麼要做）

- **現況**：供應商退貨（Vendor Return）後，NetSuite 會把價差放在「差異/調整」科目  
- **問題**：
  - 財報出現「差異科目」波動，客戶不想看到
  - 平均成本（Group Average）沒有跟退貨金額一起回滾
- **目標**：把價差**直接滾回 Inventory Asset** → 讓平均成本重算，差異科目不累積

**講者稿**
今天我們要解決一個很典型、但很煩人的問題：供應商退貨之後，NetSuite 很乖——乖到把價差乖乖放在差異科目，然後財務就開始不乖。  
客戶的要求很直白：不要差異科目，價差要回到存貨裡，平均成本要跟著回滾。這就是我們做 Cost Variance Wash 的原因。

---

## 2｜解法一句話 + 整體概念

- **一句話**：在「虛退倉」用一張 IA 做 **+1 / -1**，把價差「搬」回 Inventory Asset
- **關鍵設計**：
  - **虛退倉（Dummy Location）**：只用來調帳，不影響實體倉作業
  - **Inventory Adjustment（IA）**：數量淨變動 = 0，但金額會依 unit cost 差異留在存貨池
- **觸發時機**：Item Fulfillment（IF）**Shipped** 之後自動執行

**講者稿**
我們不用改標準分錄，也不用去跟 NetSuite 打架。  
做法是「用 NetSuite 允許你做的事」去達到你想要的結果：在虛退倉做一進一出，數量不變，但讓存貨資產的金額改變，平均成本自然會重算。這就是洗回平均成本的核心。

---

## 3｜流程（從單據到自動調整）

**流程**
- 1) 建立 **Vendor Return Authorization（VRA）**（有退貨單價 rate）
- 2) 由 VRA 產生 **Item Fulfillment（IF）**
- 3) IF 完成出貨（**Shipped**）
- 4) 系統自動建立 **Inventory Adjustment（IA）**
  - Memo：`Cost Variance Wash for IF #<IF internal id>`

**防呆**
- 同一張 IF **只會建立一次 IA**（避免重複回滾造成成本失真）

**講者稿**
這邊我強調兩個點：第一，觸發點是 IF Shipped，因為那是「標準流程已經把退貨出庫做完」的時間點。  
第二，這支腳本有防重複：同一張 IF 不會一直長 IA，否則你的平均成本會被你自己洗到失真，最後變成「洗到天邊」。

---

## 4｜會計邏輯：價差怎麼算、怎麼回滾

**定義**
- `currentAvgCost`：當下平均成本（每單位）
- `vraRate`：VRA 退貨單價（每單位）
- `quantity`：退貨數量

**要回滾的總價差**
\[
varianceTotal = (vraRate - currentAvgCost) \times quantity
\]

**IA 一進一出**
- Line A（In）：+1，`unitcost = washUnitCost`
- Line B（Out）：-1，不填 unitcost（系統用平均成本出）

**讓存貨資產金額淨變動 = varianceTotal**
\[
washUnitCost = currentAvgCost + varianceTotal
\]

**講者稿**
財務最在意的是：你到底怎麼確保價差回到存貨？  
我們用一個乾淨的推導：要回滾的是「總差額」，等於（退貨單價 - 平均成本）乘上數量。  
IA 的兩行會讓 Inventory Asset 的淨變動等於（washUnitCost - currentAvgCost）。所以我們讓它等於 varianceTotal，就能把差異科目那包金額轉回存貨資產，平均成本自然會重算。

---

## 5｜會動到哪些科目？哪裡會平？哪裡要注意？

**一定會動**
- **Inventory Asset（存貨資產）**
- **Adjustment Account（調整科目）**：由參數 `custscript_cvw_adjustment_account` 指定（例如「供應商進貨差價」）

**一定會平**
- **IA 本身一定借貸平衡**（GL Impact 成對）

**可能不如預期 / 會被跳過的情境**
- IF 行找不到對應的 VRA rate（避免算錯 → 該行跳過）
- 該 item/location `on hand <= 0`（沒有成本池基底 → 跳過）
- inventory detail 規則更嚴格（序號/批號/狀態必填）→ 需依帳上規則補足

**講者稿**
這頁是你回答 QA 的神器。  
我們動到的科目很單純：存貨資產 + 你指定的調整科目。IA 自己一定平。  
但要坦白講：如果某些條件不成立（例如抓不到 VRA rate 或 on hand 為 0），我們寧可跳過也不要亂洗，這是「控風險」而不是「偷懶」。

---

## 6｜安裝、設定、驗收（交付收尾）

**部署**
- SuiteCloud CLI：`suitecloud project:deploy`

**必要參數（Deployment Parameters）**
- `custscript_cvw_adjustment_account`：IA 的 Adjustment Account
- `custscript_cvw_dummy_location`：虛退倉 location internal id

**驗收建議（最小案例）**
- 選一個 item：讓 avg cost 與 VRA rate 有明顯差異
- 跑 VRA → IF（Shipped）→ 產生 IA
- 檢查：
  - IA GL Impact：Inventory Asset 與 Adjustment Account 是否成對
  - item/location Average Cost 是否往預期方向移動

**講者稿**
最後是交付收尾：部署一行指令、參數兩個必填。  
驗收不要搞太複雜，用最小案例：平均成本 9.225、退貨價 10，跑完看 IA 分錄跟平均成本是否移動。  
如果這兩個過了，代表核心邏輯是穩的，之後才擴到更多品項與情境。

