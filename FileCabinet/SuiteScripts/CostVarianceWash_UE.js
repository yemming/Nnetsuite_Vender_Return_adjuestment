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

                    log.debug('Processing Line', `Item: ${item}, Qty: ${quantity}, VRA Rate: ${vraRate}, Loc: ${location}`);

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

                    // 2. Calculate Variance
                    // 目標：把 Vendor Return 產生的價差「全部」滾回存貨平均成本。
                    // NetSuite 會用 currentAvgCost 來出庫，供應商退貨金額是 vraRate。
                    // 我們希望用一張 IA 的「+1 / -1」去調整 Inventory Asset 的總金額 = varianceTotal。
                    //
                    // 設：
                    //   currentAvgCost = 出庫成本（每單位）
                    //   vraRate        = 退貨金額（每單位）
                    //   quantity       = 這次退貨數量
                    //
                    // 則要滾回庫存的「總差額金額」：
                    //   varianceTotal = (vraRate - currentAvgCost) * quantity
                    //
                    // 後面我們會用一行 +1 @ washUnitCost、一行 -1 @ currentAvgCost
                    //   Inventory Asset 的變動 = washUnitCost - currentAvgCost
                    // 要讓這個變動剛好等於 varianceTotal，因此：
                    //   washUnitCost - currentAvgCost = varianceTotal
                    //   washUnitCost = currentAvgCost + varianceTotal
                    const varianceTotal = (vraRate - currentAvgCost) * quantity;

                    if (Math.abs(varianceTotal) < 0.01) {
                        log.debug('Skipping Item', 'Variance is negligible.');
                        continue;
                    }

                    // 3. Calculate Wash Unit Cost
                    // 如上推導，單一「虛擬 +1 / -1」的 IA，只要讓：
                    //   washUnitCost = currentAvgCost + varianceTotal
                    // 即可讓 Inventory Asset 的總金額多 / 少 = varianceTotal，
                    // 進而讓 Group Average 重新計算到正確的平均成本。
                    const washUnitCost = Number(currentAvgCost) + Number(varianceTotal);

                    log.debug('Calculation', `AvgCost: ${currentAvgCost}, VRA Rate: ${vraRate}, VarTotal: ${varianceTotal}, TotalQty: ${totalQtyOnHand}, WashCost: ${washUnitCost}`);

                    adjLines.push({
                        item: item,
                        washCost: washUnitCost,
                        location: p_dummy_location
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
         * Create the Inventory Adjustment record.
         * @param {Array} lines 
         * @param {string} accountId 
         * @param {string} ifId 
         * @param {string} dummyLocationId
         * @param {string} subsidiaryId
         */
        const createInventoryAdjustment = (lines, accountId, ifId, dummyLocationId, subsidiaryId) => {
            const adjRec = record.create({
                type: record.Type.INVENTORY_ADJUSTMENT,
                isDynamic: false
            });

            adjRec.setValue({ fieldId: 'subsidiary', value: subsidiaryId }); // Set Subsidiary FIRST
            adjRec.setValue({ fieldId: 'account', value: accountId });
            adjRec.setValue({ fieldId: 'memo', value: `${MEMO_PREFIX}${ifId}` });
            // Depending on environment, might need to set subsidiary first.

            lines.forEach((lineData, i) => {
                const lineIndexIn = i * 2;
                const lineIndexOut = i * 2 + 1;

                // Line 1 (In): Qty +1, Cost = washCost
                adjRec.setSublistValue({ sublistId: 'inventory', fieldId: 'item', line: lineIndexIn, value: lineData.item });
                adjRec.setSublistValue({ sublistId: 'inventory', fieldId: 'location', line: lineIndexIn, value: dummyLocationId });
                adjRec.setSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', line: lineIndexIn, value: 1 });
                adjRec.setSublistValue({ sublistId: 'inventory', fieldId: 'unitcost', line: lineIndexIn, value: lineData.washCost });

                // Configure Inventory Detail - best effort
                // 這裡不再硬塞 inventorystatus，由系統帶預設狀態，只補上數量即可。
                try {
                    const subrecIn = adjRec.getSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail', line: lineIndexIn });
                    if (subrecIn) {
                        subrecIn.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: 0, value: 1 });
                    }
                } catch (e) {
                    log.audit('Inventory Detail Skipped', `LineIn inventorydetail not set. Item ${lineData.item}. Reason: ${e}`);
                }

                // Line 2 (Out): Qty -1, Cost = Auto
                adjRec.setSublistValue({ sublistId: 'inventory', fieldId: 'item', line: lineIndexOut, value: lineData.item });
                adjRec.setSublistValue({ sublistId: 'inventory', fieldId: 'location', line: lineIndexOut, value: dummyLocationId });
                adjRec.setSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', line: lineIndexOut, value: -1 });

                // Configure Inventory Detail - best effort
                try {
                    const subrecOut = adjRec.getSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail', line: lineIndexOut });
                    if (subrecOut) {
                        // assignment 的 quantity 需與調整方向一致
                        subrecOut.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: 0, value: -1 });
                    }
                } catch (e) {
                    log.audit('Inventory Detail Skipped', `LineOut inventorydetail not set. Item ${lineData.item}. Reason: ${e}`);
                }
            });

            const adjId = adjRec.save();
            log.audit('Adjustment Created', `ID: ${adjId} for IF: ${ifId}`);
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
