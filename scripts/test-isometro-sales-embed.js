#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.join(__dirname, "..");
const indexPath = path.join(repoRoot, "index.js");
const source = fs.readFileSync(indexPath, "utf8");
const loginMarker = 'console.log("[startup] about to call client.login(...)");';
const cut = source.indexOf(loginMarker);

if (cut < 0) {
  throw new Error("Could not find Discord login marker in index.js");
}

process.env.DATA_DIR = process.env.DATA_DIR || path.join("/private/tmp", `8nap-isometro-embed-test-${process.pid}`);
process.env.RPC_HTTP_URL = process.env.RPC_HTTP_URL || "http://127.0.0.1:8545";

const ISO_TX = "0xc9b9c9a4f18fc3a3dbdfc86a5c7400bcf7bdb727f648aa4dd5de00a874125cc3";
const ISO_ANIMATION_URL_LENGTH = 458690;
const dataUrlPrefix = "data:text/html;base64,";
const isoMetadata = {
  name: "IsoMetro #51",
  image: "https://8nap.s3.eu-central-1.amazonaws.com/previews/40/max/51",
  animation_url: `${dataUrlPrefix}${"A".repeat(ISO_ANIMATION_URL_LENGTH - dataUrlPrefix.length)}`,
};

const testSource = `
(async () => {
  getEthPriceUsd = async () => null;
  formatDisplayAddress = async (address) => address ? address.slice(0, 6) + "..." + address.slice(-4) : "unknown";

  const sentPayloads = [];
  client.channels.fetch = async (id) => ({ id });
  rateLimiter.send = async (_channel, payload) => {
    sentPayloads.push(payload);
  };

  const collection = {
    name: "IsoMetro",
    artist: "Rick Crane and Rich Poole",
    standard: "erc721",
    contractAddress: "0xc43234A9892bC44Efad5b2DA8f36BC851aac06D3",
  };
  const sale = {
    txHash: "${ISO_TX}",
    blockNumber: "25405049",
    tokenId: "51",
    logIndex: "0",
    contract: collection.contractAddress,
    standard: "erc721",
    salePriceNative: "0.0127",
    currencySymbol: "WETH",
    marketplace: "seaport",
    sellerWallet: "0x2222222222222222222222222222222222222222",
    buyerWallet: "0x3333333333333333333333333333333333333333",
  };

  const metadataLoader = async () => ({
    artworkTitle: __isoMetadata.name,
    imageUrl: __isoMetadata.image,
    videoUrl: __isoMetadata.animation_url,
  });
  const originalMediaValue = "[View video](" + __isoMetadata.animation_url + ")";
  const embed = await buildSaleEmbed(collection, sale, { loadSaleRenderMetadataFn: metadataLoader });
  const data = embed.toJSON();
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const aggregateTextLength =
    (data.title || "").length +
    (data.description || "").length +
    (data.footer?.text || "").length +
    fields.reduce((n, field) => n + (field.name || "").length + (field.value || "").length, 0);

  const checks = [
    ["title", (data.title || "").length, DISCORD_EMBED_LIMITS.title],
    ["description", (data.description || "").length, DISCORD_EMBED_LIMITS.description],
    ["footer", (data.footer?.text || "").length, DISCORD_EMBED_LIMITS.footerText],
    ["total", aggregateTextLength, DISCORD_EMBED_LIMITS.totalText],
    ["fields", fields.length, DISCORD_EMBED_LIMITS.fields],
  ];
  for (let i = 0; i < fields.length; i++) {
    checks.push(["field[" + i + "].name:" + fields[i].name, (fields[i].name || "").length, DISCORD_EMBED_LIMITS.fieldName]);
    checks.push(["field[" + i + "].value:" + fields[i].name, (fields[i].value || "").length, DISCORD_EMBED_LIMITS.fieldValue]);
  }

  const failed = checks.filter((row) => row[1] > row[2]);
  if (failed.length) {
    throw new Error("Embed limit failure: " + JSON.stringify(failed));
  }

  const required = [
    collection.name,
    "Token#: **51**",
    "Price: **0.0127 WETH**",
    "Seller:",
    "Buyer:",
    "View on OpenSea",
    "View transaction",
    sale.txHash,
    "Marketplace: **seaport**",
  ];
  const haystack = JSON.stringify(data);
  const missing = required.filter((value) => !haystack.includes(value));
  if (missing.length) {
    throw new Error("Missing required sale info: " + missing.join(", "));
  }

  loadSaleRenderMetadata = metadataLoader;
  await postSale(collection, sale);
  if (sentPayloads.length !== 1) {
    throw new Error("postSale did not send exactly once");
  }
  if (!sentPayloads[0].embeds?.[0]) {
    throw new Error("postSale payload missing embed");
  }

  console.log(JSON.stringify({
    tx: sale.txHash,
    rootCauseField: "Media",
    rootCauseSource: "metadata.animation_url",
    originalMediaFieldValueLength: originalMediaValue.length,
    sanitizedMediaFieldValueLength: fields.find((field) => field.name === "Media")?.value.length,
    fieldCount: fields.length,
    titleLength: (data.title || "").length,
    descriptionLength: (data.description || "").length,
    footerLength: (data.footer?.text || "").length,
    aggregateTextLength,
    sentPayloads: sentPayloads.length,
    failedPostHandlingTriggered: false,
    checks,
  }, null, 2));
})().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
`;

vm.runInNewContext(
  `${source.slice(0, cut)}\n${testSource}`,
  {
    require,
    console,
    process,
    __dirname: repoRoot,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    BigInt,
    AggregateError,
    Error,
    Date,
    Number,
    String,
    Array,
    Object,
    JSON,
    Math,
    URL,
    URLSearchParams,
    Promise,
    Buffer,
    Set,
    WeakSet,
    Map,
    AbortController,
    fetch,
    __isoMetadata: isoMetadata,
  },
  { filename: indexPath }
);
