require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const { WebSocketProvider, Contract, getAddress, formatEther } = require("ethers");

// Load config
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CHAIN = "ethereum";

const provider = new WebSocketProvider(process.env.RPC_WEBSOCKET_URL);

// Extended ABI for auction contracts
const AUCTION_ERC721_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event PieceRevealed()",
  "event NewBidPlaced((address payable bidder, uint256 amount) bid)",
  "function currentTokenId() view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function auctionEnded() view returns (bool)"
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
      const contract = new Contract(col.contractAddress, AUCTION_ERC721_ABI, provider);
      console.log(`Watching ERC721: ${col.name}`);

      // Regular mints (skip auction collections — they mint via auction)
      contract.on("Transfer", async (from, to, tokenId, event) => {
        if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) return;
        if (["Issues", "Metamorphosis"].includes(col.name)) return;
        await handleMint(col, "erc721", contract, tokenId, event, to, 1);
      });

      // AUCTION COLLECTIONS ONLY
      if (["Issues", "Metamorphosis"].includes(col.name)) {
        console.log(`Watching Auctions for: ${col.name}`);

        contract.on("PieceRevealed", async (event) => {
          const auctionEnded = await contract.auctionEnded();
          if (auctionEnded) {
            await handlePieceRevealedAfterEnd(col, contract, event);
          } else {
            await handleNewAuctionStarted(col, contract, event);
          }
        });

        contract.on("NewBidPlaced", async (bidStruct, event) => {
          const { bidder, amount } = bidStruct;
          await handleNewBid(col, contract, bidder, amount, event);
        });
      }

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

// Main mint handler — with price + fixed images
async function handleMint(collection, standard, contract, tokenId, event, to, quantity) {
  const tokenIdStr = tokenId.toString();
  const metadata = await loadMetadata(standard, contract, tokenId);

  const title = metadata?.name || `${collection.name} #${tokenIdStr}`;
  const artist = collection.artist || "Unknown";

  // Resolve minter ENS or shorten
  let minter = to;
  try {
    const ens = await provider.lookupAddress(getAddress(to));
    if (ens) minter = ens;
    else minter = `${to.slice(0, 6)}...${to.slice(-4)}`;
  } catch {
    minter = `${to.slice(0, 6)}...${to.slice(-4)}`;
  }

  // Get image
  let imageUrl = null;
  if (metadata && metadata.image) {
    imageUrl = normalizeUri(metadata.image);
  }

  // Get mint price in ETH from the transaction (always show, even if 0)
  const tx = await event.getTransaction();
  const priceEth = formatEther(tx.value);
  let priceLine = `Price: **${priceEth} ETH**`;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const data = await res.json();
    const ethPriceUsd = data.ethereum.usd;
    const priceUsd = (parseFloat(priceEth) * ethPriceUsd).toFixed(2);
    priceLine = `Price: **${priceEth} ETH** ($${priceUsd})`;
  } catch (e) {
    console.log("CoinGecko failed, showing ETH only");
  }

  const block = await event.getBlock();
  const timestamp = block.timestamp;

  const openseaUrl = `https://opensea.io/assets/${CHAIN}/${collection.contractAddress}/${tokenIdStr}`;

  const channel = await client.channels.fetch(config.discordChannelId);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription([
      `Collection: **${collection.name}**`,
      `Artist: **${artist}**`,
      `Minting Wallet: **${minter}**`,
      priceLine,
      ...(standard === "erc1155" ? [`Quantity: **${quantity}**`] : []),
      ``,
      `[View on OpenSea](${openseaUrl})`
    ].join("\n"))
    .setTimestamp(new Date(timestamp * 1000))
    .setFooter({ text: collection.name });

  if (imageUrl) embed.setImage(imageUrl);

  await channel.send({ embeds: [embed] });
  console.log(`Mint sent: ${title} — ${priceEth} ETH`);
}

// New Auction Started (green)
async function handleNewAuctionStarted(collection, contract, event) {
  const tokenId = await contract.currentTokenId();
  const metadata = await loadMetadata("erc721", contract, tokenId);
  const imageUrl = metadata?.image ? normalizeUri(metadata.image) : null;

  const tx = await event.getTransactionReceipt();
  const revealer = tx.from;
  let revealerDisplay = revealer;
  try {
    const ens = await provider.lookupAddress(getAddress(revealer));
    if (ens) revealerDisplay = ens;
    else revealerDisplay = `${revealer.slice(0, 6)}...${revealer.slice(-4)}`;
  } catch {}

  const openingBid = collection.name === "Issues" ? "0.100" : "0.079";

  const viewLink = collection.name === "Issues" ? "https://8nap.art/collection/issues" : "https://8nap.art/collection/metamorphosis";

  const channel = await client.channels.fetch(config.auctionChannelId);

  const embed = new EmbedBuilder()
    .setTitle(`New ${collection.name} Auction Started!`)
    .setDescription([
      `Artist: **${collection.artist}**`,
      `Current Piece: #${tokenId.toString()}`,
      `Opening Bid: **${openingBid} ETH**`,
      `Bidder: **${revealerDisplay}**`,
      ``,
      `[View on 8NAP](${viewLink})`
    ].join("\n"))
    .setColor(0x00ff00)
    .setTimestamp()
    .setFooter({ text: collection.name });

  if (imageUrl) embed.setImage(imageUrl);

  await channel.send({ embeds: [embed] });
  console.log(`New auction started: ${collection.name} #${tokenId}`);
}

// New Bid Placed (red)
async function handleNewBid(collection, contract, bidder, amount, event) {
  const tokenId = await contract.currentTokenId();
  const metadata = await loadMetadata("erc721", contract, tokenId);
  const imageUrl = metadata?.image ? normalizeUri(metadata.image) : null;

  let bidderDisplay = bidder;
  try {
    const ens = await provider.lookupAddress(getAddress(bidder));
    if (ens) bidderDisplay = ens;
    else bidderDisplay = `${bidder.slice(0, 6)}...${bidder.slice(-4)}`;
  } catch {
    bidderDisplay = `${bidder.slice(0, 6)}...${bidder.slice(-4)}`;
  }

  const viewLink = collection.name === "Issues" ? "https://8nap.art/collection/issues" : "https://8nap.art/collection/metamorphosis";

  const channel = await client.channels.fetch(config.auctionChannelId);

  const embed = new EmbedBuilder()
    .setTitle(`New Bid Placed`)
    .setDescription([
      `Collection: **${collection.name}**`,
      `Piece: #${tokenId.toString()}`,
      `Bidder: **${bidderDisplay}**`,
      `Amount: **${formatEther(amount)} ETH**`,
      ``,
      `[View on 8NAP](${viewLink})`
    ].join("\n"))
    .setColor(0xff0000)
    .setTimestamp()
    .setFooter({ text: collection.name });

  if (imageUrl) embed.setImage(imageUrl);

  await channel.send({ embeds: [embed] });
  console.log(`Auction bid sent: ${collection.name} - ${formatEther(amount)} ETH`);
}

// Piece Revealed After Auction Ended (purple)
async function handlePieceRevealedAfterEnd(collection, contract, event) {
  const tokenId = await contract.currentTokenId();
  const metadata = await loadMetadata("erc721", contract, tokenId);
  const imageUrl = metadata?.image ? normalizeUri(metadata.image) : null;

  const tx = await event.getTransactionReceipt();
  const revealer = tx.from;
  let revealerDisplay = revealer;
  try {
    const ens = await provider.lookupAddress(getAddress(revealer));
    if (ens) revealerDisplay = ens;
    else revealerDisplay = `${revealer.slice(0, 6)}...${revealer.slice(-4)}`;
  } catch {}

  const viewLink = collection.name === "Issues" ? "https://8nap.art/collection/issues" : "https://8nap.art/collection/metamorphosis";

  const channel = await client.channels.fetch(config.auctionChannelId);

  const embed = new EmbedBuilder()
    .setTitle(`Piece Revealed After Auction Ended`)
    .setDescription([
      `Collection: **${collection.name}**`,
      `Artist: **${collection.artist}**`,
      `Revealed by: **${revealerDisplay}**`,
      `Piece #${tokenId.toString()} is now revealed and ready for the next auction!`,
      ``,
      `[View on 8NAP](${viewLink})`
    ].join("\n"))
    .setColor(0x9d00ff)
    .setTimestamp()
    .setFooter({ text: collection.name });

  if (imageUrl) embed.setImage(imageUrl);

  await channel.send({ embeds: [embed] });
  console.log(`Post-auction reveal sent: ${collection.name} #${tokenId}`);
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
    return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  }
  if (uri.startsWith("data:application/json;base64,")) {
    const base64 = uri.slice(29); // remove the prefix
    const json = Buffer.from(base64, "base64").toString("utf-8");
    const data = JSON.parse(json);
    if (data.image && data.image.startsWith("data:image")) {
      return data.image;
    }
    return normalizeUri(data.image); // recursive in case it's ipfs inside
  }
  return uri; // normal https:// link
}

client.login(process.env.DISCORD_BOT_TOKEN);