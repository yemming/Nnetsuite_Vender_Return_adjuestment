/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope Public
 */
define(['N/record', 'N/search', 'N/runtime', 'N/log'],

    (record, search, runtime, log) => {

        const MEMO_PREFIX = 'Cost Variance Wash for IF #';

        /**
         * Function definition to be triggered before record is loaded.
         *
         * @param {Object} scriptContext
         * @param {Record} scriptContext.newRecord - New record
         * @param {Record} scriptContext.oldRecord - Old record
         * @param {string} scriptContext.type - Trigger type
         */
        const afterSubmit = (scriptContext) => {

            const startMsg = `[CostVarianceWash] Started | Type: ${scriptContext.type}`;
            log.debug('afterSubmit', startMsg);

            try {
                // Filter: Only trigger on creation or edit (if relevant logic applies on edit - adhering to requirements generally implies on creation/shipping)
                // Requirement said: "Trigger only if createdfrom is a vendorreturnauthorization" and "Trigger only if status is Shipped"
                // Usually Item Fulfillment status 'Shipped' is final.

                if (scriptContext.type === scriptContext.UserEventType.DELETE) return;

                // Strategy Change: Use search.lookup to find the "Truth" about the record status.
                // record.load sometimes returns undefined for header fields in afterSubmit depending on the flow.
                // 'shipstatus' is not a valid search column. Must use 'status'.
                const lookup = search.lookupFields({
                    type: scriptContext.newRecord.type,
                    id: scriptContext.newRecord.id,
                    columns: ['status', 'createdfrom']
                });

                log.debug('Lookup Debug', JSON.stringify(lookup));

                // Parse Lookup Results
                // result.status is usually [{value: 'ItemShip:C', text: 'Shipped'}] for Item Fulfillment
                const statusValue = lookup.status && lookup.status.length > 0 ? lookup.status[0].value : null;
                const statusText = lookup.status && lookup.status.length > 0 ? lookup.status[0].text : null;
                const createdFrom = lookup.createdfrom && lookup.createdfrom.length > 0 ? lookup.createdfrom[0].value : null;

                log.debug('Context Check', `CreatedFrom: ${createdFrom}, StatusValue: ${statusValue}, StatusText: ${statusText}`);

                // Guard: Must be Created From VRA (Check record type of createdFrom)
                if (!createdFrom) return;

                const newRecord = scriptContext.newRecord; // Use the context record for lines, it's cheaper and usually sufficient for looping.

                // Simple check: if we can't easily see type without lookup, we trust the deployment or check a known field.
                // Assuming 'createdfrom' lookup for type 'vendorreturnauthorization'.

                // Fetch Script Parameters
                const scriptObj = runtime.getCurrentScript();
                const p_adjustment_account = scriptObj.getParameter({ name: 'custscript_cvw_adjustment_account' });
                const p_dummy_location = scriptObj.getParameter({ name: 'custscript_cvw_dummy_location' });

                if (!p_adjustment_account || !p_dummy_location) {
                    log.error('Config Error', 'Missing Script Parameters: Adjustment Account or Dummy Location');
                    return;
                }

                // Verify Logic: Is it VRA? 
                const createdFromLookup = search.lookupFields({
                    type: search.Type.TRANSACTION,
                    id: createdFrom,
                    columns: ['recordtype']
                });
                const createdFromType = (typeof createdFromLookup.recordtype === 'string')
                    ? createdFromLookup.recordtype
                    : (createdFromLookup.recordtype && createdFromLookup.recordtype.length > 0 ? createdFromLookup.recordtype[0].value : null);

                // Note: recordtype for VRA is 'vendorreturnauthorization'
                if (createdFromType !== 'vendorreturnauthorization') {
                    log.debug('Skipping', 'Source is not Vendor Return Authorization');
                    return;
                }

                // Verify Status: 'Shipped'. 
                // ItemShip:C is standard, but lookup might return 'shipped' (lowercase) or 'C' depending on account.
                // Log confirmed value is 'shipped'.
                // We check for all likely variants to be safe.
                const validStatusValues = ['ItemShip:C', 'shipped', 'C'];
                const validStatusTexts = ['Shipped'];
                const isShipped = validStatusValues.includes(statusValue) || validStatusTexts.includes(statusText);
                if (!isShipped) {
                    // Check if it's potentially 'Shipped' as a text or if status is Shipped
                    log.debug('Skipping', `Status is not Shipped. Current Value/Text: ${statusValue}/${statusText}`);
                    return;
                }

                // --- Main Logic ---

                // Idempotency Guard: prevent duplicate Inventory Adjustments for the same IF
                // We use memo prefix search as a safe guard without requiring custom fields.
                if (hasExistingAdjustmentForIF(newRecord.id)) {
                    log.audit('Skipping', `Inventory Adjustment already exists for IF ${newRecord.id}.`);
                    return;
                }

                // Need to load the source VRA record to get the true return rate on each line.
                // IF 上的 rate 不一定可靠（可能是 0 或被表單隱藏），用 lineuniquekey 對應回 VRA 才準。
                const vraRateMapByLineKey = {};
                try {
                    const vraRec = record.load({
                        type: record.Type.VENDOR_RETURN_AUTHORIZATION,
                        id: createdFrom,
                        isDynamic: false
                    });
                    const vraLineCount = vraRec.getLineCount({ sublistId: 'item' });
                    for (let v = 0; v < vraLineCount; v++) {
                        // Use both 'line' (Line ID) and 'lineuniquekey' for robust matching
                        const vraLineId = vraRec.getSublistValue({ sublistId: 'item', fieldId: 'line', line: v });
                        const vraLineKey = vraRec.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: v });
                        const vraRateOnVRA = vraRec.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: v });

                        if (vraRateOnVRA !== null && vraRateOnVRA !== '' && typeof vraRateOnVRA !== 'undefined') {
                            const rateNum = Number(vraRateOnVRA);
                            if (vraLineId) vraRateMapByLineKey[String(vraLineId)] = rateNum;
                            if (vraLineKey) vraRateMapByLineKey[String(vraLineKey)] = rateNum;
                        }
                    }
                    log.debug('VRA Rate Map Built', JSON.stringify(vraRateMapByLineKey));
                } catch (e) {
                    log.error('VRA Load/Map Error', e);
                }

                const lineCount = newRecord.getLineCount({ sublistId: 'item' });
                const adjLines = []; // Store data to create adjustment later
                const inventoryCache = {}; // key: `${itemId}|${locationId}`

                for (let i = 0; i < lineCount; i++) {
                    const item = newRecord.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                    const quantity = newRecord.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i });
                    const location = newRecord.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i });
                    const unitConversionRate = Number(newRecord.getSublistValue({ sublistId: 'item', fieldId: 'unitconversionrate', line: i })) || 1;

                    // Match IF line to VRA line using orderline (Source Line ID) or lineuniquekey
                    const orderLine = newRecord.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i });
                    const lineKey = newRecord.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i });

                    log.debug('Line Key Check', `Item: ${item} | OrderLine: ${orderLine} | LineUniqueKey: ${lineKey}`);

                    // Try matching by orderline first (standard), then lineuniquekey
                    let vraRateRaw = null;
                    if (orderLine && vraRateMapByLineKey[String(orderLine)] !== undefined) {
                        vraRateRaw = vraRateMapByLineKey[String(orderLine)];
                    } else if (lineKey && vraRateMapByLineKey[String(lineKey)] !== undefined) {
                        vraRateRaw = vraRateMapByLineKey[String(lineKey)];
                    }

                    const vraRate = (vraRateRaw === null || typeof vraRateRaw === 'undefined' || vraRateRaw === '') ? null : Number(vraRateRaw);

                    const itemType = newRecord.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
                    // Skip non-inventory items (Description, Subtotal, etc.)
                    // Best way: check if it has a valid item ID and is inventory.
                    if (!item || quantity <= 0) continue;

                    if (vraRate === null || Number.isNaN(vraRate)) {
                        log.audit('Skipping Line', `Missing/Invalid rate on IF line. Item: ${item}, Qty: ${quantity}, Loc: ${location}`);
                        continue;
                    }

                    log.debug('Processing Line', `Item: ${item}, Qty: ${quantity}, VRA Rate: ${vraRate}, Loc: ${location}, UOM Rate: ${unitConversionRate}`);

                    // 1. Get Inventory State (Avg Cost & Total Qty)
                    const cacheKey = `${item}|${location}`;
                    const inventoryData = inventoryCache[cacheKey] || (inventoryCache[cacheKey] = getInventoryData(item, location));

                    if (!inventoryData) {
                        log.audit('Skipping Item', `Could not fetch inventory data for item ${item}`);
                        continue;
                    }

                    const { currentAvgCost, totalQtyOnHand } = inventoryData;

                    // Guard Clause
                    if (totalQtyOnHand <= 0) {
                        log.audit('Skipping Item', `Total Qty on Hand (${totalQtyOnHand}) <= 0 for item ${item}. Cannot wash variance.`);
                        continue;
                    }

                    // 2. Calculate Variance (Base Unit)
                    const assignments = getInventoryAssignmentsFromIF(newRecord, i);
                    const assignmentTotalQty = assignments.reduce((sum, a) => sum + (Number(a.quantity) || 0), 0);
                    const baseQty = assignmentTotalQty > 0 ? assignmentTotalQty : (Number(quantity) || 0) * unitConversionRate;
                    if (baseQty <= 0) {
                        log.audit('Skipping Item', `Base Qty <= 0 for item ${item}.`);
                        continue;
                    }

                    const vraRatePerBase = Number(vraRate) / unitConversionRate;

                    // 目標：把 Vendor Return 產生的價差「全部」滾回存貨平均成本。
                    // NetSuite 會用 currentAvgCost 來出庫，供應商退貨金額是 vraRate。
                    // Advanced Inventory/UOM：用 Base Unit 計算。
                    const varianceTotal = (vraRatePerBase - currentAvgCost) * baseQty;

                    if (Math.abs(varianceTotal) < 0.01) {
                        log.debug('Skipping Item', 'Variance is negligible.');
                        continue;
                    }

                    // 3. Calculate Wash Unit Cost
                    // 用 Base Unit 的 VRA 單價，配合 +baseQty / -baseQty
                    const washUnitCost = Number(vraRatePerBase);

                    log.debug('Calculation', `AvgCost: ${currentAvgCost}, VRA Rate(Base): ${vraRatePerBase}, VarTotal: ${varianceTotal}, BaseQty: ${baseQty}, TotalQty: ${totalQtyOnHand}, WashCost: ${washUnitCost}`);

                    adjLines.push({
                        item: item,
                        washCost: washUnitCost,
                        location: location || p_dummy_location,
                        assignments: assignments,
                        adjustQty: baseQty
                    });

                }

                // 4. Create Adjustment if needed
                if (adjLines.length > 0) {
                    createInventoryAdjustment(adjLines, p_adjustment_account, newRecord.id, p_dummy_location, newRecord.getValue('subsidiary'));
                }

            } catch (e) {
                log.error('Critical Error', e.toString());
                // Do not throw, effectively swallowing the error to prevent transaction block, as requested.
            }
        }

        // --- Helper Functions ---

        /**
         * Get Average Cost and Total Quantity on Hand for an item at a location.
         * Using a Saved Search is safer than record.load for cost data.
         * @param {string} itemId 
         * @param {string} locationId 
         */
        const getInventoryData = (itemId, locationId) => {
            // Need to handle Location Costing vs Average Costing.
            // Assuming Location Costing.
            // Search filters: Item = itemId, Location = locationId
            // Columns: locationaveragecost, locationquantityonhand

            try {
                const itemSearch = search.create({
                    type: search.Type.ITEM,
                    filters: [
                        ['internalid', search.Operator.IS, itemId],
                        'AND',
                        ['inventorylocation', search.Operator.IS, locationId]
                    ],
                    columns: [
                        'locationaveragecost',
                        'locationquantityonhand'
                    ]
                });

                const results = itemSearch.run().getRange({ start: 0, end: 1 });
                if (results && results.length > 0) {
                    const avgCost = results[0].getValue({ name: 'locationaveragecost' });
                    const qtyOnHand = results[0].getValue({ name: 'locationquantityonhand' });
                    return {
                        currentAvgCost: parseFloat(avgCost) || 0,
                        totalQtyOnHand: parseFloat(qtyOnHand) || 0
                    };
                }
                return null;
            } catch (e) {
                log.error('Search Error', e);
                return null;
            }
        }

        /**
         * 使用 N/record 建立 Inventory Adjustment，純 SuiteScript 不呼叫外部 API。
         * 每個品項寫兩行：+1 @ washCost（入庫）、-1（出庫，系統以平均成本扣減）。
         * Advanced Inventory 情境下，會嘗試把 IF 的 inventorydetail 帶進 IA。
         * @param {Array} lines - [{ item, washCost, location, assignments }]
         * @param {string} accountId - 調整科目
         * @param {string} ifId - Item Fulfillment ID（寫入 memo）
         * @param {string} dummyLocationId - 虛擬倉（與 Script Parameter 一致）
         * @param {string} subsidiaryId - 子公司
         */
        const createInventoryAdjustment = (lines, accountId, ifId, dummyLocationId, subsidiaryId) => {
            try {
                // dynamic 模式才有 selectNewLine / setCurrentSublistValue / commitLine
                const adjRec = record.create({
                    type: record.Type.INVENTORY_ADJUSTMENT,
                    isDynamic: true
                });

                // IA 表頭順序：Subsidiary -> Adjustment Account
                adjRec.setValue({ fieldId: 'subsidiary', value: subsidiaryId });
                adjRec.setValue({ fieldId: 'account', value: accountId });
                adjRec.setValue({ fieldId: 'tranDate', value: new Date() });
                adjRec.setValue({ fieldId: 'memo', value: `${MEMO_PREFIX}${ifId}` });

                lines.forEach((lineData) => {
                    const effectiveLocation = lineData.location || dummyLocationId;
                    const adjustQty = Number(lineData.adjustQty) || 1;

                    // ============================================================
                    // Advanced Inventory 環境下，IA 欄位設定順序至關重要！
                    // 正確順序：item → location → adjustqtyby → inventorydetail → unitcost → commitLine
                    // 
                    // ★★★ 關鍵發現 ★★★
                    // inventory detail 的 assignment quantity 必須等於 adjustqtyby！
                    // 如果 adjustqtyby = 10，inventory assignment 也必須是 qty=10。
                    // 不能複製 IF 的原始 assignments（可能是多個 qty=1 的行）。
                    // ============================================================

                    // 從 IF 取得第一個 assignment 的 inventory status（如果有的話）
                    const firstAssignment = lineData.assignments && lineData.assignments.length > 0 
                        ? lineData.assignments[0] 
                        : null;
                    const inventoryStatusId = firstAssignment ? firstAssignment.inventoryStatusId : null;

                    log.debug('IA Line Prep', `Item: ${lineData.item}, AdjQty: ${adjustQty}, Status: ${inventoryStatusId}`);

                    // 行一：+adjustQty 入庫 @ washCost
                    adjRec.selectNewLine({ sublistId: 'inventory' });
                    adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: lineData.item });
                    adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location', value: effectiveLocation });
                    adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: adjustQty });
                    
                    // ★ 處理 inventory detail：創建單一 assignment，quantity = adjustQty
                    applyInventoryDetailForAdjustment(adjRec, adjustQty, inventoryStatusId, 'in');
                    
                    adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'unitcost', value: lineData.washCost });
                    adjRec.commitLine({ sublistId: 'inventory' });

                    // 行二：-adjustQty 出庫（不設 unitcost，由系統以該地點平均成本扣減）
                    adjRec.selectNewLine({ sublistId: 'inventory' });
                    adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: lineData.item });
                    adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location', value: effectiveLocation });
                    adjRec.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: -adjustQty });
                    
                    // ★ 處理 inventory detail：創建單一 assignment，quantity = adjustQty
                    applyInventoryDetailForAdjustment(adjRec, adjustQty, inventoryStatusId, 'out');
                    
                    // 出庫不設 unitcost，讓系統自動用平均成本
                    adjRec.commitLine({ sublistId: 'inventory' });
                });

                const adjId = adjRec.save();
                log.audit('Adjustment Created', `ID: ${adjId} for IF: ${ifId}`);
            } catch (e) {
                log.error('Create Inventory Adjustment Failed', e.toString());
            }
        }

        /**
         * 從 Item Fulfillment 讀取 inventorydetail（Advanced Inventory）。
         * @param {Record} ifRec
         * @param {number} lineIndex
         * @returns {Array} [{ quantity, inventoryNumberId, binNumberId, inventoryStatusId }]
         */
        const getInventoryAssignmentsFromIF = (ifRec, lineIndex) => {
            try {
                const subrec = ifRec.getSublistSubrecord({
                    sublistId: 'item',
                    fieldId: 'inventorydetail',
                    line: lineIndex
                });
                if (!subrec) return [];

                const assignmentCount = subrec.getLineCount({ sublistId: 'inventoryassignment' });
                if (!assignmentCount) return [];

                const assignments = [];
                for (let a = 0; a < assignmentCount; a++) {
                    const quantity = subrec.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: a });
                    const binNumberId = subrec.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', line: a });
                    const issueInvId = subrec.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', line: a });
                    const receiptInvId = subrec.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', line: a });
                    const inventoryStatusId = subrec.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'inventorystatus', line: a });

                    assignments.push({
                        quantity: Number(quantity) || 0,
                        inventoryNumberId: issueInvId || receiptInvId || null,
                        binNumberId: binNumberId || null,
                        inventoryStatusId: inventoryStatusId || null
                    });
                }

                return assignments;
            } catch (e) {
                log.debug('InventoryDetail Read Skip', e.toString());
                return [];
            }
        }

        /**
         * 為 IA 當前列設定 inventory detail（簡化版，專為 Inventory Status 設計）。
         * 
         * ★★★ 關鍵 ★★★
         * inventory assignment 的 quantity 必須等於 adjustqtyby！
         * 這是 NetSuite Advanced Inventory 的硬性要求。
         * 
         * 此函數必須在設定 adjustqtyby 之後、設定 unitcost 之前呼叫！
         * 
         * @param {Record} adjRec - Inventory Adjustment record (dynamic mode)
         * @param {number} adjustQty - 調整數量（必須與 adjustqtyby 一致）
         * @param {string|number|null} inventoryStatusId - Inventory Status ID（如果使用）
         * @param {'in'|'out'} direction - 'in' 用於入庫，'out' 用於出庫
         */
        const applyInventoryDetailForAdjustment = (adjRec, adjustQty, inventoryStatusId, direction) => {
            try {
                const invDetail = adjRec.getCurrentSublistSubrecord({
                    sublistId: 'inventory',
                    fieldId: 'inventorydetail'
                });
                
                if (!invDetail) {
                    log.debug('InventoryDetail Skip', 'No inventorydetail subrecord (item may not require it)');
                    return;
                }

                // ★★★ 關鍵修正 ★★★
                // 入庫（in）: quantity 必須是正數
                // 出庫（out）: quantity 必須是負數
                const effectiveQty = direction === 'out' ? -Math.abs(adjustQty) : Math.abs(adjustQty);

                // 檢查是否已經有系統自動建立的行
                const existingLineCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });
                log.debug('InventoryDetail Check', `Direction: ${direction}, ExistingLines: ${existingLineCount}, EffectiveQty: ${effectiveQty}, Status: ${inventoryStatusId}`);

                if (existingLineCount > 0) {
                    // ★ NetSuite 可能已經自動建立了 assignment 行
                    // 我們需要編輯第一行，而不是新增
                    invDetail.selectLine({ sublistId: 'inventoryassignment', line: 0 });
                    
                    // 設定 Inventory Status（如果有）
                    if (inventoryStatusId) {
                        invDetail.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'inventorystatus',
                            value: inventoryStatusId
                        });
                    }
                    
                    // ★ 關鍵：設定 quantity（入庫正數，出庫負數）
                    invDetail.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'quantity',
                        value: effectiveQty
                    });
                    
                    invDetail.commitLine({ sublistId: 'inventoryassignment' });
                    log.debug('InventoryDetail Updated', `Edited line 0: qty=${effectiveQty}, status=${inventoryStatusId}`);
                } else {
                    // 沒有現有行，新增一行
                    invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                    
                    // 設定 Inventory Status（如果有）
                    if (inventoryStatusId) {
                        invDetail.setCurrentSublistValue({
                            sublistId: 'inventoryassignment',
                            fieldId: 'inventorystatus',
                            value: inventoryStatusId
                        });
                    }
                    
                    // ★ 關鍵：設定 quantity（入庫正數，出庫負數）
                    invDetail.setCurrentSublistValue({
                        sublistId: 'inventoryassignment',
                        fieldId: 'quantity',
                        value: effectiveQty
                    });
                    
                    invDetail.commitLine({ sublistId: 'inventoryassignment' });
                    log.debug('InventoryDetail Created', `New line: qty=${effectiveQty}, status=${inventoryStatusId}`);
                }
            } catch (e) {
                // 記錄錯誤但不中斷流程
                log.error('InventoryDetail Failed', `Direction: ${direction}, Error: ${e.toString()}`);
            }
        }

        /**
         * 【已棄用】原始的 inventory detail 處理函數
         * 保留以供參考，但不再使用
         */
        const applyInventoryDetailToCurrentLine = (adjRec, assignments, direction) => {
            // 此函數已被 applyInventoryDetailForAdjustment 取代
            log.debug('Deprecated', 'applyInventoryDetailToCurrentLine is deprecated');
        }

        /**
         * Check if an Inventory Adjustment already exists for the given Item Fulfillment.
         * This prevents duplicate adjustments when the IF is edited/resaved.
         * @param {string|number} ifId
         * @returns {boolean}
         */
        const hasExistingAdjustmentForIF = (ifId) => {
            try {
                const s = search.create({
                    type: search.Type.INVENTORY_ADJUSTMENT,
                    filters: [
                        ['mainline', search.Operator.IS, 'T'],
                        'AND',
                        ['memo', search.Operator.CONTAINS, `${MEMO_PREFIX}${ifId}`]
                    ],
                    columns: ['internalid']
                });
                const r = s.run().getRange({ start: 0, end: 1 });
                return !!(r && r.length > 0);
            } catch (e) {
                // If search fails for any reason, do NOT block processing; just proceed.
                log.error('Idempotency Check Failed', e);
                return false;
            }
        }


        return {
            afterSubmit: afterSubmit
        };
    }
);
