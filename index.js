require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");
const { WebSocketProvider, Contract, getAddress } = require("ethers");

// Load config
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CHAIN = "ethereum";

const provider = new WebSocketProvider(process.env.RPC_WEBSOCKET_URL);

// Minimal ABIs
const ERC721_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function tokenURI(uint256 tokenId) view returns (string)"
];

const ERC1155_ABI = [
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "function uri(uint256 id) view returns (string)"
];

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  startWatchers().catch(err => console.error("Error during watchers:", err));
});

// Start watchers for each collection
async function startWatchers() {
  for (const col of config.collections) {
    if (!col.contractAddress || !col.standard) continue;

    if (col.standard.toLowerCase() === "erc721") {
      const contract = new Contract(col.contractAddress, ERC721_ABI, provider);
      console.log(`Watching ERC721: ${col.name}`);

      contract.on("Transfer", async (from, to, tokenId, event) => {
        if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) return;
        await handleMint(col, "erc721", contract, tokenId, event, to, 1);
      });

    } else if (col.standard.toLowerCase() === "erc1155") {
      const contract = new Contract(col.contractAddress, ERC1155_ABI, provider);
      console.log(`Watching ERC1155: ${col.name}`);

      contract.on("TransferSingle", async (op, from, to, id, value, event) => {
        if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) return;
        await handleMint(col, "erc1155", contract, id, event, to, value);
      });

      contract.on("TransferBatch", async (op, from, to, ids, values, event) => {
        if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) return;
        for (let i = 0; i < ids.length; i++) {
          await handleMint(col, "erc1155", contract, ids[i], event, to, values[i]);
        }
      });
    }
  }
}

// Main mint handler
async function handleMint(collection, standard, contract, tokenId, event, to, quantity) {
  const tokenIdStr = tokenId.toString();
  const metadata = await loadMetadata(standard, contract, tokenId);

  const title = metadata?.name || `${collection.name} #${tokenIdStr}`;
  const artist = collection.artist || "Unknown";

  // Resolve ENS or shorten address
  let minter = to;
  try {
    const ens = await provider.lookupAddress(getAddress(to));
    if (ens) minter = ens;
    else minter = `${to.slice(0, 6)}...${to.slice(-4)}`;
  } catch {
    minter = `${to.slice(0, 6)}...${to.slice(-4)}`;
  }

  // Try to resolve an image URL from metadata
  let imageUrl = null;
  if (metadata && metadata.image) {
    imageUrl = normalizeUri(metadata.image);
  }

  const block = await event.getBlock();
  const timestamp = block.timestamp;

  const openseaUrl = `https://opensea.io/assets/${CHAIN}/${collection.contractAddress}/${tokenIdStr}`;

  const channel = await client.channels.fetch(config.discordChannelId);

  // Build an embed so Discord shows a big image preview
  const embed = {
    title: title,
    description: [
      `Collection: **${collection.name}**`,
      `Artist: **${artist}**`,
      `Minting Wallet: **${minter}**`,
      ...(standard === "erc1155" ? [`Quantity: **${quantity}**`] : []),
      ``,
      `[View on OpenSea](${openseaUrl})`
    ].join("\n"),
    timestamp: new Date(timestamp * 1000).toISOString()
  };

  if (imageUrl) {
    embed.image = { url: imageUrl };
  }

  await channel.send({ embeds: [embed] });
  console.log(`Mint sent (with embed): ${title}`);
}

async function loadMetadata(standard, contract, tokenId) {
  try {
    let uri;
    if (standard === "erc721") {
      uri = await contract.tokenURI(tokenId);
    } else {
      uri = await contract.uri(tokenId);
      uri = fix1155Uri(uri, tokenId);
    }

    const url = normalizeUri(uri);
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function fix1155Uri(uri, tokenId) {
  const hexId = tokenId.toString(16).padStart(64, "0");
  return uri.replace("{id}", hexId).replace("{ID}", hexId);
}

function normalizeUri(uri) {
  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.replace("ipfs://", "")}`;
  }
  return uri;
}

client.login(process.env.DISCORD_BOT_TOKEN);