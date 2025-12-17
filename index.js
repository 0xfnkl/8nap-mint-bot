require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const { WebSocketProvider, Contract, getAddress, formatEther } = require("ethers");

// Validate environment variables
if (!process.env.DISCORD_BOT_TOKEN || !process.env.RPC_WEBSOCKET_URL) {
  console.error('❌ Missing required environment variables: DISCORD_BOT_TOKEN or RPC_WEBSOCKET_URL');
  process.exit(1);
}

// Load config
const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CHAIN = "ethereum";

// Provider with reconnection logic
let provider;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
const contracts = new Map(); // Store contract instances

// Track last processed block for each collection to avoid reprocessing
const lastProcessedBlock = new Map();

// Polling backup - checks for missed mints every 2 minutes
async function startPollingBackup() {
  setInterval(async () => {
    try {
      console.log('🔍 Running polling backup check...');
      
      for (const col of config.collections) {
        if (!col.contractAddress || !col.standard) continue;
        
        const contract = contracts.get(col.contractAddress);
        if (!contract) continue;
        
        const currentBlock = await provider.getBlockNumber();
        const lastBlock = lastProcessedBlock.get(col.contractAddress) || currentBlock - 100;
        
        // Only check last 100 blocks max to avoid too many RPC calls
        const fromBlock = Math.max(lastBlock + 1, currentBlock - 100);
        
        if (fromBlock > currentBlock) continue;
        
        try {
          if (col.standard.toLowerCase() === 'erc1155') {
            // Check for TransferSingle events
            const singleEvents = await contract.queryFilter(
              contract.filters.TransferSingle(null, '0x0000000000000000000000000000000000000000'),
              fromBlock,
              currentBlock
            );
            
            // Check for TransferBatch events
            const batchEvents = await contract.queryFilter(
              contract.filters.TransferBatch(null, '0x0000000000000000000000000000000000000000'),
              fromBlock,
              currentBlock
            );
            
            if (singleEvents.length > 0 || batchEvents.length > 0) {
              console.log(`📦 Polling found ${singleEvents.length + batchEvents.length} ERC1155 events for ${col.name}`);
            }
            
            for (const event of singleEvents) {
              const eventId = `${event.transactionHash}-${event.logIndex}-single`;
              if (!processedEvents.has(eventId)) {
                console.log(`⚠️  Missed mint detected! Processing ${col.name} token ${event.args.id}`);
                eventQueue.push({
                  eventId,
                  handler: () => handleMint(col, 'erc1155', contract, event.args.id, event, event.args.to, event.args.value)
                });
              }
            }
            
            for (const event of batchEvents) {
              const ids = event.args.ids;
              const values = event.args.values;
              for (let i = 0; i < ids.length; i++) {
                const eventId = `${event.transactionHash}-${event.logIndex}-batch-${i}`;
                if (!processedEvents.has(eventId)) {
                  console.log(`⚠️  Missed mint detected! Processing ${col.name} token ${ids[i]}`);
                  eventQueue.push({
                    eventId,
                    handler: () => handleMint(col, 'erc1155', contract, ids[i], event, event.args.to, values[i])
                  });
                }
              }
            }
          } else if (col.standard.toLowerCase() === 'erc721') {
            // Skip Issues/Metamorphosis mints (handled by auction events)
            if (["Issues", "Metamorphosis"].includes(col.name)) continue;
            
            const events = await contract.queryFilter(
              contract.filters.Transfer('0x0000000000000000000000000000000000000000'),
              fromBlock,
              currentBlock
            );
            
            if (events.length > 0) {
              console.log(`📦 Polling found ${events.length} ERC721 events for ${col.name}`);
            }
            
            for (const event of events) {
              const eventId = `${event.transactionHash}-${event.logIndex}-transfer`;
              if (!processedEvents.has(eventId)) {
                console.log(`⚠️  Missed mint detected! Processing ${col.name} token ${event.args.tokenId}`);
                eventQueue.push({
                  eventId,
                  handler: () => handleMint(col, 'erc721', contract, event.args.tokenId, event, event.args.to, 1)
                });
              }
            }
          }
        } catch (error) {
          console.error(`Error polling ${col.name}:`, error.message);
        }
        
        lastProcessedBlock.set(col.contractAddress, currentBlock);
      }
    } catch (error) {
      console.error('❌ Error in polling backup:', error);
    }
  }, 120000); // Every 2 minutes
}

// Scan recent blocks on startup to catch mints during downtime
async function scanRecentBlocks() {
  try {
    console.log('🔎 Scanning last 100 blocks for missed events during downtime...');
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = currentBlock - 100;
    
    for (const col of config.collections) {
      if (!col.contractAddress || !col.standard) continue;
      
      const contract = contracts.get(col.contractAddress);
      if (!contract) continue;
      
      try {
        if (col.standard.toLowerCase() === 'erc1155') {
          const singleEvents = await contract.queryFilter(
            contract.filters.TransferSingle(null, '0x0000000000000000000000000000000000000000'),
            fromBlock,
            currentBlock
          );
          
          const batchEvents = await contract.queryFilter(
            contract.filters.TransferBatch(null, '0x0000000000000000000000000000000000000000'),
            fromBlock,
            currentBlock
          );
          
          if (singleEvents.length > 0 || batchEvents.length > 0) {
            console.log(`📦 Found ${singleEvents.length + batchEvents.length} recent ${col.name} events`);
          }
          
          for (const event of singleEvents) {
            const eventId = `${event.transactionHash}-${event.logIndex}-single`;
            eventQueue.push({
              eventId,
              handler: () => handleMint(col, 'erc1155', contract, event.args.id, event, event.args.to, event.args.value)
            });
          }
          
          for (const event of batchEvents) {
            const ids = event.args.ids;
            const values = event.args.values;
            for (let i = 0; i < ids.length; i++) {
              const eventId = `${event.transactionHash}-${event.logIndex}-batch-${i}`;
              eventQueue.push({
                eventId,
                handler: () => handleMint(col, 'erc1155', contract, ids[i], event, event.args.to, values[i])
              });
            }
          }
        } else if (col.standard.toLowerCase() === 'erc721') {
          if (["Issues", "Metamorphosis"].includes(col.name)) continue;
          
          const events = await contract.queryFilter(
            contract.filters.Transfer('0x0000000000000000000000000000000000000000'),
            fromBlock,
            currentBlock
          );
          
          if (events.length > 0) {
            console.log(`📦 Found ${events.length} recent ${col.name} events`);
          }
          
          for (const event of events) {
            const eventId = `${event.transactionHash}-${event.logIndex}-transfer`;
            eventQueue.push({
              eventId,
              handler: () => handleMint(col, 'erc721', contract, event.args.tokenId, event, event.args.to, 1)
            });
          }
        }
      } catch (error) {
        console.error(`Error scanning ${col.name}:`, error.message);
      }
      
      lastProcessedBlock.set(col.contractAddress, currentBlock);
    }
    
    console.log('✅ Startup scan complete');
  } catch (error) {
    console.error('❌ Error scanning recent blocks:', error);
  }
}

// ABIs
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

// Discord rate limiter
const rateLimiter = {
  lastSent: 0,
  
  async send(channel, message) {
    const now = Date.now();
    const timeSinceLastSent = now - this.lastSent;
    
    // Discord allows 5 messages per 5 seconds, so wait 1.2s between messages to be safe
    if (timeSinceLastSent < 1200) {
      await new Promise(r => setTimeout(r, 1200 - timeSinceLastSent));
    }
    
    await channel.send(message);
    this.lastSent = Date.now();
  }
};

// ETH price cache (60 second cache)
let cachedEthPrice = null;
let cacheTime = 0;

async function getEthPrice() {
  if (Date.now() - cacheTime < 60000 && cachedEthPrice) {
    return cachedEthPrice;
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    
    const data = await res.json();
    cachedEthPrice = data.ethereum.usd;
    cacheTime = Date.now();
    return cachedEthPrice;
  } catch (e) {
    console.log("⚠️  CoinGecko API failed, using cached/no USD price");
    return cachedEthPrice;
  }
}

// Retry wrapper for async functions
async function retryAsync(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      console.log(`Retry ${i + 1}/${retries} failed:`, e.message);
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

// Event queue processor with deduplication
const processQueue = async () => {
  if (isProcessing || eventQueue.length === 0) return;
  isProcessing = true;
  
  while (eventQueue.length > 0) {
    const { handler, eventId } = eventQueue.shift();
    
    // Skip duplicates
    if (processedEvents.has(eventId)) {
      console.log(`⏭️  Skipping duplicate event: ${eventId}`);
      continue;
    }
    
    processedEvents.add(eventId);
    
    // Prevent memory leak - keep only last 5000 events
    if (processedEvents.size > 10000) {
      const arr = Array.from(processedEvents);
      processedEvents.clear();
      arr.slice(-5000).forEach(id => processedEvents.add(id));
      console.log("🧹 Cleaned up processed events cache");
    }
    
    try { 
      await handler(); 
    } catch (e) { 
      console.error("❌ Queue processing error:", e);
    }
  }
  
  isProcessing = false;
};

// Process queue more frequently
setInterval(processQueue, 100);

// Create provider with reconnection logic
async function createProvider() {
  try {
    if (provider) {
      try {
        await provider.destroy();
      } catch (e) {
        console.log("Error destroying old provider:", e.message);
      }
    }

    console.log("🔌 Connecting to WebSocket...");
    provider = new WebSocketProvider(process.env.RPC_WEBSOCKET_URL);
    
    // Wait for connection to be ready first
    await provider.getNetwork();
    console.log("✅ WebSocket connected");
    reconnectAttempts = 0;
    
    // Now attach WebSocket event handlers (after connection is established)
    if (provider._websocket) {
      provider._websocket.on('close', (code, reason) => {
        console.error(`❌ WebSocket closed (code: ${code}, reason: ${reason})`);
        handleReconnect();
      });
      
      provider._websocket.on('error', (err) => {
        console.error('❌ WebSocket error:', err.message);
      });
    }
    
    // Reattach listeners after reconnect
    await startWatchers();
    
    // Scan for missed events on first connection
    if (reconnectAttempts === 0) {
      await scanRecentBlocks();
      startPollingBackup();
    }
    
    console.log("✅ Provider ready and watchers started");
  } catch (error) {
    console.error("❌ Failed to create provider:", error.message);
    console.error("Full error:", error);
    handleReconnect();
  }
}

function handleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT) {
    console.error(`❌ Max reconnection attempts (${MAX_RECONNECT}) reached. Exiting.`);
    process.exit(1);
  }
  
  reconnectAttempts++;
  const delay = Math.min(5000 * reconnectAttempts, 30000); // Max 30s delay
  console.log(`🔄 Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT})...`);
  
  setTimeout(() => {
    createProvider().catch(err => {
      console.error("❌ Reconnection failed:", err.message);
    });
  }, delay);
}

client.once("ready", () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
  createProvider().catch(err => {
    console.error("❌ Error during initial connection:", err);
    process.exit(1);
  });
});

// Start watchers for each collection
async function startWatchers() {
  // Clear old contracts
  for (const [addr, contract] of contracts.entries()) {
    try {
      contract.removeAllListeners();
    } catch (e) {
      console.log("Error removing listeners:", e.message);
    }
  }
  contracts.clear();

  for (const col of config.collections) {
    if (!col.contractAddress || !col.standard) continue;

    if (col.standard.toLowerCase() === "erc721") {
      const contract = new Contract(col.contractAddress, AUCTION_ERC721_ABI, provider);
      contracts.set(col.contractAddress, contract);
      console.log(`👀 Watching ERC721: ${col.name}`);

      contract.on("Transfer", async (from, to, tokenId, event) => {
        if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) return;
        
        // Skip mint posts for Issues/Metamorphosis - they're handled by auction events
        if (["Issues", "Metamorphosis"].includes(col.name)) return;
        
        const eventId = `${event.transactionHash}-${event.logIndex}-transfer`;
        eventQueue.push({ 
          eventId,
          handler: () => handleMint(col, "erc721", contract, tokenId, event, to, 1) 
        });
      });

      // Auction watchers only for Issues and Metamorphosis
      if (["Issues", "Metamorphosis"].includes(col.name)) {
        console.log(`🎯 Watching Auctions for: ${col.name}`);

        contract.on("PieceRevealed", async (event) => {
          const eventId = `${event.transactionHash}-${event.logIndex}-revealed`;
          eventQueue.push({ 
            eventId,
            handler: async () => {
              // PieceRevealed means: previous auction ended (if there was one) and next piece is revealed
              await handlePieceRevealed(col, contract, event);
            }
          });
        });

        contract.on("NewBidPlaced", async (bidStruct, event) => {
          const { bidder, amount } = bidStruct;
          const eventId = `${event.transactionHash}-${event.logIndex}-bid`;
          eventQueue.push({ 
            eventId,
            handler: () => handleNewBid(col, contract, bidder, amount, event) 
          });
        });
      }

    } else if (col.standard.toLowerCase() === "erc1155") {
      const contract = new Contract(col.contractAddress, ERC1155_ABI, provider);
      contracts.set(col.contractAddress, contract);
      console.log(`👀 Watching ERC1155: ${col.name}`);

      contract.on("TransferSingle", async (op, from, to, id, value, event) => {
        if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) return;
        const eventId = `${event.transactionHash}-${event.logIndex}-single`;
        eventQueue.push({ 
          eventId,
          handler: () => handleMint(col, "erc1155", contract, id, event, to, value) 
        });
      });

      contract.on("TransferBatch", async (op, from, to, ids, values, event) => {
        if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) return;
        for (let i = 0; i < ids.length; i++) {
          const eventId = `${event.transactionHash}-${event.logIndex}-batch-${i}`;
          eventQueue.push({ 
            eventId,
            handler: () => handleMint(col, "erc1155", contract, ids[i], event, to, values[i]) 
          });
        }
      });
    }
  }
}

// Main mint handler
async function handleMint(collection, standard, contract, tokenId, event, to, quantity) {
  try {
    const tokenIdStr = tokenId.toString();
    console.log(`🎨 Processing mint: ${collection.name} #${tokenIdStr}`);
    
    // For Issues and Metamorphosis, use 8NAP's S3 bucket directly (contract metadata is stale)
    let imageUrl = null;
    let title = `${collection.name} #${tokenIdStr}`;
    
    if (collection.name === "Issues") {
      imageUrl = `https://8nap.s3.eu-central-1.amazonaws.com/previews/74/small/${tokenIdStr}`;
    } else if (collection.name === "Metamorphosis") {
      imageUrl = `https://8nap.s3.eu-central-1.amazonaws.com/previews/107/small/${tokenIdStr}`;
    } else {
      // For other collections, load metadata normally
      const metadata = await retryAsync(() => loadMetadata(standard, contract, tokenId));
      title = metadata?.name || title;
      if (metadata && metadata.image) {
        imageUrl = normalizeUri(metadata.image);
      }
    }

    const artist = collection.artist || "Unknown";

    let minter = to;
    try {
      const ens = await provider.lookupAddress(getAddress(to));
      if (ens) minter = ens;
      else minter = `${to.slice(0, 6)}...${to.slice(-4)}`;
    } catch {
      minter = `${to.slice(0, 6)}...${to.slice(-4)}`;
    }

    const tx = await event.getTransaction();
    const priceEth = formatEther(tx.value);
    let priceLine = `Price: **${priceEth} ETH**`;
    
    const ethPriceUsd = await getEthPrice();
    if (ethPriceUsd) {
      const priceUsd = (parseFloat(priceEth) * ethPriceUsd).toFixed(2);
      priceLine = `Price: **${priceEth} ETH** ($${priceUsd})`;
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

    await rateLimiter.send(channel, { embeds: [embed] });
    console.log(`✅ Mint sent: ${title} — ${priceEth} ETH`);
  } catch (error) {
    console.error(`❌ Error handling mint for ${collection.name}:`, error);
  }
}

// New Auction Started
async function handleNewAuctionStarted(collection, contract, event) {
  try {
    console.log(`🎯 New auction started: ${collection.name}`);
    
    const tokenId = await contract.currentTokenId();
    const tokenIdStr = tokenId.toString();
    
    // Use 8NAP's S3 bucket for correct images
    let imageUrl = null;
    if (collection.name === "Issues") {
      imageUrl = `https://8nap.s3.eu-central-1.amazonaws.com/previews/74/small/${tokenIdStr}`;
    } else if (collection.name === "Metamorphosis") {
      imageUrl = `https://8nap.s3.eu-central-1.amazonaws.com/previews/107/small/${tokenIdStr}`;
    }

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

    await rateLimiter.send(channel, { embeds: [embed] });
    console.log(`✅ New auction started: ${collection.name} #${tokenId}`);
  } catch (error) {
    console.error(`❌ Error handling auction start for ${collection.name}:`, error);
  }
}

// New Bid Placed
async function handleNewBid(collection, contract, bidder, amount, event) {
  try {
    console.log(`💰 New bid: ${collection.name}`);
    
    const tokenId = await contract.currentTokenId();
    const tokenIdStr = tokenId.toString();
    
    // Use 8NAP's S3 bucket for correct images
    let imageUrl = null;
    if (collection.name === "Issues") {
      imageUrl = `https://8nap.s3.eu-central-1.amazonaws.com/previews/74/small/${tokenIdStr}`;
    } else if (collection.name === "Metamorphosis") {
      imageUrl = `https://8nap.s3.eu-central-1.amazonaws.com/previews/107/small/${tokenIdStr}`;
    }

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
        `Piece: #${tokenIdStr}`,
        `Bidder: **${bidderDisplay}**`,
        `Amount: **${formatEther(amount)} ETH**`,
        ``,
        `[View on 8NAP](${viewLink})`
      ].join("\n"))
      .setColor(0xff0000)
      .setTimestamp()
      .setFooter({ text: collection.name });

    if (imageUrl) embed.setImage(imageUrl);

    await rateLimiter.send(channel, { embeds: [embed] });
    console.log(`✅ Auction bid sent: ${collection.name} - ${formatEther(amount)} ETH`);
  } catch (error) {
    console.error(`❌ Error handling bid for ${collection.name}:`, error);
  }
}

// Piece Revealed After Auction Ended
async function handlePieceRevealedAfterEnd(collection, contract, event) {
  try {
    console.log(`🎨 Piece revealed after auction: ${collection.name}`);
    
    const tokenId = await contract.currentTokenId();
    const tokenIdStr = tokenId.toString();
    
    // Use 8NAP's S3 bucket for correct images
    let imageUrl = null;
    if (collection.name === "Issues") {
      imageUrl = `https://8nap.s3.eu-central-1.amazonaws.com/previews/74/small/${tokenIdStr}`;
    } else if (collection.name === "Metamorphosis") {
      imageUrl = `https://8nap.s3.eu-central-1.amazonaws.com/previews/107/small/${tokenIdStr}`;
    }

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
        `Piece #${tokenIdStr} is now revealed and ready for the next auction!`,
        ``,
        `[View on 8NAP](${viewLink})`
      ].join("\n"))
      .setColor(0x9d00ff)
      .setTimestamp()
      .setFooter({ text: collection.name });

    if (imageUrl) embed.setImage(imageUrl);

    await rateLimiter.send(channel, { embeds: [embed] });
    console.log(`✅ Post-auction reveal sent: ${collection.name} #${tokenIdStr}`);
  } catch (error) {
    console.error(`❌ Error handling post-auction reveal for ${collection.name}:`, error);
  }
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
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.log("⚠️  Failed to load metadata:", e.message);
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
    const base64 = uri.slice(29);
    const json = Buffer.from(base64, "base64").toString("utf-8");
    const data = JSON.parse(json);
    if (data.image && data.image.startsWith("data:image")) {
      return data.image;
    }
    return normalizeUri(data.image);
  }
  return uri;
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down gracefully...');
  await processQueue(); // Finish processing queue
  if (provider) await provider.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  await processQueue();
  if (provider) await provider.destroy();
  process.exit(0);
});

// Heartbeat monitoring (every 5 minutes)
setInterval(() => {
  const queueSize = eventQueue.size;
  const cacheSize = processedEvents.size;
  console.log(`💓 Heartbeat: Queue=${queueSize}, Cache=${cacheSize}, Reconnects=${reconnectAttempts}`);
}, 300000);

client.login(process.env.DISCORD_BOT_TOKEN);