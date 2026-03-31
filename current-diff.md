# Current Diff

Generated: `2026-03-31 12:56:57 PDT`

Source: `git diff`

```diff
diff --git a/index.js b/index.js
index 65cf5a0..9904d3b 100644
--- a/index.js
+++ b/index.js
@@ -702,12 +702,17 @@ function isIssuesSalesCollection(collection) {
   return safeLowercaseAddress(collection?.contractAddress) === ISSUES_SALES_CANARY_CONTRACT;
 }
 
+function supportsErc721SalesFallback(collection) {
+  return safeString(collection?.standard).trim().toLowerCase() === "erc721" &&
+    isNonEmptyString(collection?.contractAddress);
+}
+
 function isEthLikeCurrencySymbol(symbol) {
   const normalized = safeString(symbol).trim().toUpperCase();
   return normalized === "ETH" || normalized === "WETH";
 }
 
-async function decodeSeaportEthLikeSalePrice(candidate, receipt) {
+async function decodeErc721SeaportEthLikeSalePrice(candidate, receipt) {
   if (!candidate || !receipt) {
     return { salePriceNative: "", currencySymbol: "" };
   }
@@ -814,7 +819,7 @@ async function getNFTSalesPage(collection, options = {}) {
   };
 }
 
-function normalizeIssuesOnchainCandidateToSales(candidate, collection) {
+function normalizeErc721OnchainCandidateToSales(candidate, collection) {
   const transfers = Array.isArray(candidate?.transfers) ? candidate.transfers : [];
   const contract = safeLowercaseAddress(collection?.contractAddress);
   const normalizedSales = transfers.map((transfer) => ({
@@ -913,14 +918,17 @@ async function postSale(collection, sale) {
   await rateLimiter.send(channel, { embeds: [embed] });
 }
 
-async function findIssuesOnchainSaleCandidatesInRange(fromBlock, toBlock) {
+async function findErc721OnchainSaleCandidatesInRange(collection, fromBlock, toBlock) {
   const boundedFromBlock = Math.max(0, Number(fromBlock) || 0);
   const boundedToBlock = Math.max(boundedFromBlock, Number(toBlock) || boundedFromBlock);
+  const contractAddress = safeLowercaseAddress(collection?.contractAddress);
 
-  console.log(`[sales:onchain] range fromBlock=${boundedFromBlock} toBlock=${boundedToBlock}`);
+  if (!contractAddress) return [];
+
+  console.log(`[sales:onchain] range collection=${safeString(collection?.name).trim() || contractAddress} fromBlock=${boundedFromBlock} toBlock=${boundedToBlock}`);
 
   const transferLogs = await provider.getLogs({
-    address: ISSUES_SALES_CANARY_CONTRACT,
+    address: contractAddress,
     fromBlock: boundedFromBlock,
     toBlock: boundedToBlock,
     topics: [[ERC721_TRANSFER_TOPIC]],
@@ -995,7 +1003,7 @@ async function findIssuesOnchainSaleCandidatesInRange(fromBlock, toBlock) {
 
     if (!marketplaceAddressMatched) continue;
 
-    const { salePriceNative, currencySymbol } = await decodeSeaportEthLikeSalePrice(groupedTransfer, receipt);
+    const { salePriceNative, currencySymbol } = await decodeErc721SeaportEthLikeSalePrice(groupedTransfer, receipt);
 
     const candidate = {
       transactionHash: groupedTransfer.transactionHash,
@@ -1050,7 +1058,7 @@ async function pollSalesOnce() {
   for (const collection of collections) {
     const collectionName = safeString(collection?.name).trim() || "(unnamed sales collection)";
     const collectionKey = safeLowercaseAddress(collection?.contractAddress) || collectionName.toLowerCase();
-    const issuesCollection = isIssuesSalesCollection(collection);
+    const erc721FallbackEligible = supportsErc721SalesFallback(collection);
     const currentState = loadSalesState(collectionKey);
     const configuredStartBlock = Number.isInteger(collection.startBlock) && collection.startBlock >= 0
       ? collection.startBlock
@@ -1085,10 +1093,10 @@ async function pollSalesOnce() {
       });
 
       let normalizedSales = Array.isArray(page.sales) ? page.sales : [];
-      if (normalizedSales.length === 0 && issuesCollection) {
-        const onchainCandidates = await findIssuesOnchainSaleCandidatesInRange(fromBlock, toBlock);
+      if (normalizedSales.length === 0 && erc721FallbackEligible) {
+        const onchainCandidates = await findErc721OnchainSaleCandidatesInRange(collection, fromBlock, toBlock);
         normalizedSales = onchainCandidates.flatMap((candidate) =>
-          normalizeIssuesOnchainCandidateToSales(candidate, collection)
+          normalizeErc721OnchainCandidateToSales(candidate, collection)
         );
         console.log(
           `[sales:onchain] fallback collection=${collectionName} fromBlock=${fromBlock} toBlock=${toBlock} candidateCount=${onchainCandidates.length} normalizedSales=${normalizedSales.length}`
@@ -1099,9 +1107,7 @@ async function pollSalesOnce() {
       for (const sale of normalizedSales) {
         const key = saleKeyFromRecord(sale);
         if (nextState.processed[key]) continue;
-        if (issuesCollection) {
-          await postSale(collection, sale);
-        }
+        await postSale(collection, sale);
         nextState.processed[key] = true;
         newSalesCount += 1;
       }
 ```
