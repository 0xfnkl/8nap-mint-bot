# Current Diff

Generated: `2026-03-31 12:23:59 PDT`

Source: `git diff -- index.js`

```diff
diff --git a/index.js b/index.js
index 41b9195..65cf5a0 100644
--- a/index.js
+++ b/index.js
@@ -691,6 +691,7 @@ function saleKeyFromRecord(sale) {
 }
 
 const ISSUES_SALES_CANARY_CONTRACT = "0xbe27770b0263133b9d3a1d4c7c2760007b94e37f";
+const WETH_MAINNET_ADDRESS = "0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
 const KNOWN_MARKETPLACE_MATCHERS = [
   { address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", matchedBy: "seaport" },
   { address: "0x00000000006c3852cbef3e08e8df289169ede581", matchedBy: "seaport" },
@@ -701,6 +702,66 @@ function isIssuesSalesCollection(collection) {
   return safeLowercaseAddress(collection?.contractAddress) === ISSUES_SALES_CANARY_CONTRACT;
 }
 
+function isEthLikeCurrencySymbol(symbol) {
+  const normalized = safeString(symbol).trim().toUpperCase();
+  return normalized === "ETH" || normalized === "WETH";
+}
+
+async function decodeSeaportEthLikeSalePrice(candidate, receipt) {
+  if (!candidate || !receipt) {
+    return { salePriceNative: "", currencySymbol: "" };
+  }
+
+  if (!Array.isArray(candidate.transfers) || candidate.transfers.length !== 1) {
+    return { salePriceNative: "", currencySymbol: "" };
+  }
+
+  try {
+    const tx = await provider.getTransaction(candidate.transactionHash);
+    if (tx?.value != null && tx.value > 0n) {
+      return {
+        salePriceNative: ethers.formatEther(tx.value),
+        currencySymbol: "ETH",
+      };
+    }
+  } catch {}
+
+  const buyerAddresses = new Set(
+    (Array.isArray(candidate.toAddresses) ? candidate.toAddresses : [])
+      .map((address) => safeLowercaseAddress(address))
+      .filter(Boolean)
+  );
+  if (buyerAddresses.size === 0) {
+    return { salePriceNative: "", currencySymbol: "" };
+  }
+
+  let totalWeth = 0n;
+  for (const log of Array.isArray(receipt.logs) ? receipt.logs : []) {
+    if (safeLowercaseAddress(log?.address) !== safeLowercaseAddress(WETH_MAINNET_ADDRESS)) continue;
+    if (safeLowercaseString(log?.topics?.[0]) !== ERC20_TRANSFER_TOPIC.toLowerCase()) continue;
+
+    try {
+      const parsed = ERC20_TRANSFER_IFACE.parseLog(log);
+      if (parsed?.name !== "Transfer") continue;
+
+      const from = safeLowercaseAddress(parsed.args.from);
+      if (!buyerAddresses.has(from)) continue;
+
+      const value = BigInt(parsed.args.value?.toString?.() ?? "0");
+      if (value > 0n) totalWeth += value;
+    } catch {}
+  }
+
+  if (totalWeth > 0n) {
+    return {
+      salePriceNative: ethers.formatEther(totalWeth),
+      currencySymbol: "WETH",
+    };
+  }
+
+  return { salePriceNative: "", currencySymbol: "" };
+}
+
 const mintPollingCollections = config.collections.filter((collection) => !isIssuesSalesCollection(collection));
 
 async function getNFTSalesPage(collection, options = {}) {
@@ -763,8 +824,8 @@ function normalizeIssuesOnchainCandidateToSales(candidate, collection) {
     quantity: "1",
     sellerWallet: safeLowercaseAddress(transfer?.from),
     buyerWallet: safeLowercaseAddress(transfer?.to),
-    salePriceNative: "",
-    currencySymbol: "",
+    salePriceNative: safeString(candidate?.salePriceNative).trim(),
+    currencySymbol: safeString(candidate?.currencySymbol).trim().toUpperCase(),
     marketplace: safeString(candidate?.matchedBy || candidate?.marketplaceAddressMatched).trim().toLowerCase(),
     tokenId: safeString(transfer?.tokenId).trim(),
     contract,
@@ -774,14 +835,40 @@ function normalizeIssuesOnchainCandidateToSales(candidate, collection) {
   }));
 
   if (normalizedSales.length > 0) {
-    console.log(
-      `[sales:onchain] fallback normalized tx=${safeLowercaseString(candidate?.transactionHash)} rows=${normalizedSales.length} salePriceNative=missing currencySymbol=missing reason=price-decoding-not-implemented`
-    );
+    const salePriceNative = safeString(candidate?.salePriceNative).trim() || "missing";
+    const currencySymbol = safeString(candidate?.currencySymbol).trim().toUpperCase() || "missing";
+    console.log(`[sales:onchain] fallback normalized tx=${safeLowercaseString(candidate?.transactionHash)} rows=${normalizedSales.length} salePriceNative=${salePriceNative} currencySymbol=${currencySymbol}`);
   }
 
   return normalizedSales;
 }
 
+async function formatSalePriceLine(sale) {
+  if (!isNonEmptyString(sale?.salePriceNative)) {
+    return "Price: **Unavailable**";
+  }
+
+  const nativeAmount = safeString(sale.salePriceNative).trim();
+  const currencySymbol = safeString(sale.currencySymbol).trim().toUpperCase();
+  const basePrice = currencySymbol ? `${nativeAmount} ${currencySymbol}` : nativeAmount;
+
+  if (!isEthLikeCurrencySymbol(currencySymbol)) {
+    return `Price: **${basePrice}**`;
+  }
+
+  const nativeAmountNumber = Number(nativeAmount);
+  if (!Number.isFinite(nativeAmountNumber) || nativeAmountNumber < 0) {
+    return `Price: **${basePrice}**`;
+  }
+
+  const ethUsd = await getEthPriceUsd();
+  if (!ethUsd) {
+    return `Price: **${basePrice}**`;
+  }
+
+  return `Price: **${basePrice}** ($${(nativeAmountNumber * ethUsd).toFixed(2)})`;
+}
+
 async function postSale(collection, sale) {
   const tokenId = safeString(sale?.tokenId).trim() || "unknown";
   const sellerWallet = safeLowercaseAddress(sale?.sellerWallet);
@@ -794,11 +881,7 @@ async function postSale(collection, sale) {
   const sellerDisplay = sellerWallet ? await formatDisplayAddress(sellerWallet) : "unknown";
   const buyerDisplay = buyerWallet ? await formatDisplayAddress(buyerWallet) : "unknown";
 
-  let priceLine = "Price: **Unavailable**";
-  if (isNonEmptyString(sale?.salePriceNative)) {
-    const symbol = isNonEmptyString(sale?.currencySymbol) ? ` ${safeString(sale.currencySymbol).trim()}` : "";
-    priceLine = `Price: **${safeString(sale.salePriceNative).trim()}${symbol}**`;
-  }
+  const priceLine = await formatSalePriceLine(sale);
 
   let timestampMs = Date.now();
   const blockNumber = Number(blockNumberText);
@@ -912,6 +995,8 @@ async function findIssuesOnchainSaleCandidatesInRange(fromBlock, toBlock) {
 
     if (!marketplaceAddressMatched) continue;
 
+    const { salePriceNative, currencySymbol } = await decodeSeaportEthLikeSalePrice(groupedTransfer, receipt);
+
     const candidate = {
       transactionHash: groupedTransfer.transactionHash,
       blockNumber: safeString(groupedTransfer.blockNumber).trim(),
@@ -921,6 +1006,8 @@ async function findIssuesOnchainSaleCandidatesInRange(fromBlock, toBlock) {
       transfers: groupedTransfer.transfers.map((transfer) => ({ ...transfer })),
       marketplaceAddressMatched,
       matchedBy,
+      salePriceNative,
+      currencySymbol,
       transferCount: groupedTransfer.transferCount,
     };
 
@@ -1274,12 +1361,16 @@ const ERC165_ABI = [
 const ERC721_TRANSFER_IFACE = new ethers.Interface([
   "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
 ]);
+const ERC20_TRANSFER_IFACE = new ethers.Interface([
+  "event Transfer(address indexed from, address indexed to, uint256 value)",
+]);
 const ERC1155_TRANSFER_IFACE = new ethers.Interface([
   "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
   "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
 ]);
 
 const ERC721_TRANSFER_TOPIC = ERC721_TRANSFER_IFACE.getEvent("Transfer").topicHash;
+const ERC20_TRANSFER_TOPIC = ERC20_TRANSFER_IFACE.getEvent("Transfer").topicHash;
 const ERC1155_TRANSFER_SINGLE_TOPIC = ERC1155_TRANSFER_IFACE.getEvent("TransferSingle").topicHash;
 const ERC1155_TRANSFER_BATCH_TOPIC = ERC1155_TRANSFER_IFACE.getEvent("TransferBatch").topicHash;
 ```
