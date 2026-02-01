import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

// Track background process for proper lifecycle management
let backgroundProcess: ChildProcess | null = null;
let serviceRunning = false;

// Auto-import tracking
let autoImportInterval: any = null;
let knownTxids: Set<string> = new Set();

// Budget tracking
const BUDGET_FILE = 'daily-spending.json';

interface DailySpending {
  date: string; // YYYY-MM-DD
  totalSats: number;
  transactions: Array<{ ts: number; sats: number; service: string; provider: string }>;
}

function getBudgetPath(walletDir: string): string {
  return path.join(walletDir, BUDGET_FILE);
}

function loadDailySpending(walletDir: string): DailySpending {
  const today = new Date().toISOString().slice(0, 10);
  const budgetPath = getBudgetPath(walletDir);
  try {
    const data = JSON.parse(fs.readFileSync(budgetPath, 'utf-8'));
    if (data.date === today) return data;
  } catch {
    // Ignore parse errors - return fresh daily spending for corrupted/missing file
  }
  return { date: today, totalSats: 0, transactions: [] };
}

function recordSpend(walletDir: string, sats: number, service: string, provider: string) {
  const spending = loadDailySpending(walletDir);
  spending.totalSats += sats;
  spending.transactions.push({ ts: Date.now(), sats, service, provider });
  fs.writeFileSync(getBudgetPath(walletDir), JSON.stringify(spending, null, 2));
}

function checkBudget(walletDir: string, requestedSats: number, dailyLimit: number): { allowed: boolean; remaining: number; spent: number } {
  const spending = loadDailySpending(walletDir);
  const remaining = dailyLimit - spending.totalSats;
  return {
    allowed: remaining >= requestedSats,
    remaining,
    spent: spending.totalSats
  };
}

async function startAutoImport(env, cliPath, logger) {
  // Get our address
  try {
    const addrResult = await execFileAsync('node', [cliPath, 'address'], { env });
    const addrOutput = parseCliOutput(addrResult.stdout);
    if (!addrOutput.success) return;
    const address = addrOutput.data?.address;
    if (!address) return;
    
    // Load known txids from wallet state
    const balResult = await execFileAsync('node', [cliPath, 'balance'], { env });
    const balOutput = parseCliOutput(balResult.stdout);
    // Track what we already have
    
    autoImportInterval = setInterval(async () => {
      try {
        const network = env.BSV_NETWORK === 'testnet' ? 'test' : 'main';
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const resp = await fetch(`https://api.whatsonchain.com/v1/bsv/${network}/address/${address}/unspent`, { signal: controller.signal });
          if (!resp.ok) return;
        const utxos = await resp.json();
        
        for (const utxo of utxos) {
          const key = `${utxo.tx_hash}:${utxo.tx_pos}`;
          if (knownTxids.has(key)) continue;
          if (utxo.value < 200) continue; // skip dust
          
          logger?.info?.(`[bsv-overlay] Auto-importing UTXO: ${utxo.tx_hash}:${utxo.tx_pos} (${utxo.value} sats)`);
          try {
            const importResult = await execFileAsync('node', [cliPath, 'import', utxo.tx_hash, String(utxo.tx_pos)], { env });
            const importOutput = parseCliOutput(importResult.stdout);
            if (importOutput.success) {
              knownTxids.add(key);
              logger?.info?.(`[bsv-overlay] Auto-imported ${utxo.value} sats from ${utxo.tx_hash}`);
              
              // Check if registered, auto-register if not
              try {
                const regPath = path.join(process.env.HOME || '', '.clawdbot', 'bsv-overlay', 'registration.json');
                if (!fs.existsSync(regPath)) {
                  logger?.info?.('[bsv-overlay] Not yet registered — auto-registering...');
                  const regResult = await execFileAsync('node', [cliPath, 'register'], { env, timeout: 60000 });
                  const regOutput = parseCliOutput(regResult.stdout);
                  if (regOutput.success) {
                    logger?.info?.('[bsv-overlay] Auto-registered on overlay network!');
                  }
                }
              } catch (err) {
                logger?.warn?.('[bsv-overlay] Auto-registration failed:', err.message);
              }
            }
          } catch (err) {
            // Already imported or error — track it so we don't retry
            knownTxids.add(key);
          }
        }
      } catch (err) {
        // WoC API error — just skip this cycle
      } finally {
        clearTimeout(timeout);
      }
    }, 60000); // Check every 60 seconds
  } catch (err) {
    logger?.warn?.('[bsv-overlay] Auto-import setup failed:', err.message);
  }
}

function stopAutoImport() {
  if (autoImportInterval) {
    clearInterval(autoImportInterval);
    autoImportInterval = null;
  }
}

function startBackgroundService(env, cliPath, logger) {
  if (backgroundProcess) return;
  serviceRunning = true;
  
  function spawnConnect() {
    if (!serviceRunning) return;
    
    const proc = spawn('node', [cliPath, 'connect'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    backgroundProcess = proc;
    
    proc.stdout?.on('data', (data) => {
      // Log incoming service fulfillments
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          logger?.debug?.(`[bsv-overlay] ${event.event || event.type || 'message'}:`, JSON.stringify(event).slice(0, 200));
        } catch {}
      }
    });
    
    proc.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'connected') {
            logger?.info?.('[bsv-overlay] WebSocket relay connected');
          } else if (event.event === 'disconnected') {
            logger?.warn?.('[bsv-overlay] WebSocket disconnected, reconnecting...');
          }
        } catch {
          logger?.debug?.(`[bsv-overlay] ${line}`);
        }
      }
    });
    
    proc.on('exit', (code) => {
      backgroundProcess = null;
      if (serviceRunning) {
        logger?.warn?.(`[bsv-overlay] Background service exited (code ${code}), restarting in 5s...`);
        setTimeout(spawnConnect, 5000);
      }
    });
  }
  
  spawnConnect();
}

function stopBackgroundService() {
  serviceRunning = false;
  if (backgroundProcess) {
    backgroundProcess.kill('SIGTERM');
    backgroundProcess = null;
  }
  stopAutoImport();
}

export default async function register(api) {
  // Capture config at registration time (api.getConfig may not be available later)
  const pluginConfig = api.getConfig?.()?.plugins?.entries?.['bsv-overlay']?.config || api.config || {};

  // Register the overlay agent tool
  api.registerTool({
    name: "overlay",
    description: "Access the BSV agent marketplace - discover agents and exchange BSV micropayments for services",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "request", "discover", "balance", "status", "pay", 
            "setup", "address", "import", "register", "advertise", 
            "readvertise", "remove", "send", "inbox", "services", "refund",
            "onboard", "pending-requests", "fulfill"
          ],
          description: "Action to perform"
        },
        service: {
          type: "string",
          description: "Service ID for request/discover"
        },
        input: {
          type: "object",
          description: "Service-specific input data"
        },
        maxPrice: {
          type: "number",
          description: "Max sats willing to pay"
        },
        identityKey: {
          type: "string",
          description: "Target agent key for direct pay/send"
        },
        sats: {
          type: "number",
          description: "Amount for direct pay"
        },
        description: {
          type: "string"
        },
        agent: {
          type: "string",
          description: "Agent name filter for discover"
        },
        // Import parameters
        txid: {
          type: "string",
          description: "Transaction ID for import"
        },
        vout: {
          type: "number",
          description: "Output index for import (optional)"
        },
        // Service management parameters
        serviceId: {
          type: "string",
          description: "Service ID for advertise/readvertise/remove"
        },
        name: {
          type: "string",
          description: "Service name for advertise/readvertise"
        },
        priceSats: {
          type: "number",
          description: "Price in satoshis for advertise"
        },
        newPrice: {
          type: "number",
          description: "New price for readvertise"
        },
        newName: {
          type: "string",
          description: "New name for readvertise (optional)"
        },
        newDesc: {
          type: "string",
          description: "New description for readvertise (optional)"
        },
        // Messaging parameters
        messageType: {
          type: "string",
          description: "Message type for send"
        },
        payload: {
          type: "object",
          description: "Message payload for send"
        },
        // Refund parameters
        address: {
          type: "string",
          description: "Destination address for refund"
        },
        // Fulfill parameters
        requestId: {
          type: "string",
          description: "Request ID for fulfill"
        },
        recipientKey: {
          type: "string",
          description: "Recipient identity key for fulfill"
        },
        result: {
          type: "object",
          description: "Service result for fulfill"
        }
      },
      required: ["action"]
    },
    async execute(id, params) {
      const config = pluginConfig;
      
      try {
        const result = await executeOverlayAction(params, config, api);
        return { 
          content: [{ 
            type: "text", 
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          }] 
        };
      } catch (error) {
        return { 
          content: [{ 
            type: "text", 
            text: `Error: ${error.message}` 
          }] 
        };
      }
    }
  });

  // Register background service for WebSocket relay
  api.registerService({
    id: "bsv-overlay-relay",
    start: async () => {
      api.logger.info("Starting BSV overlay WebSocket relay...");
      try {
        const config = pluginConfig;
        const env = buildEnvironment(config);
        const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');
        
        // Use the improved background service
        startBackgroundService(env, cliPath, api.logger);
        
        // Start auto-import
        startAutoImport(env, cliPath, api.logger);

        api.logger.info("BSV overlay WebSocket relay started");
      } catch (error) {
        api.logger.error(`Failed to start BSV overlay relay: ${error.message}`);
      }
    },
    stop: async () => {
      api.logger.info("Stopping BSV overlay WebSocket relay...");
      stopBackgroundService();
      api.logger.info("BSV overlay WebSocket relay stopped");
    }
  });

  // Register CLI commands
  api.registerCli(({ program }) => {
    const overlay = program.command("overlay").description("BSV Overlay Network commands");
    
    overlay.command("status")
      .description("Show identity, balance, registration, and services")
      .action(async () => {
        try {
          const config = pluginConfig;
          const result = await handleStatus(buildEnvironment(config), path.join(__dirname, 'scripts', 'overlay-cli.mjs'));
          console.log("BSV Overlay Status:");
          console.log("Identity:", result.identity);
          console.log("Balance:", result.balance);
          console.log("Services:", result.services);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
    
    overlay.command("balance")
      .description("Show wallet balance")
      .action(async () => {
        try {
          const config = pluginConfig;
          const result = await handleBalance(buildEnvironment(config), path.join(__dirname, 'scripts', 'overlay-cli.mjs'));
          console.log("Balance:", result);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });

    overlay.command("address")
      .description("Show receive address")
      .action(async () => {
        try {
          const config = pluginConfig;
          const result = await handleAddress(buildEnvironment(config), path.join(__dirname, 'scripts', 'overlay-cli.mjs'));
          console.log("Address:", result);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });

    overlay.command("discover")
      .description("List agents and services on the network")
      .option("--service <type>", "Filter by service type")
      .option("--agent <name>", "Filter by agent name")
      .action(async (options) => {
        try {
          const config = pluginConfig;
          const result = await handleDiscover(options, buildEnvironment(config), path.join(__dirname, 'scripts', 'overlay-cli.mjs'));
          console.log("Discovery results:");
          console.log(`Overlay URL: ${result.overlayUrl}`);
          console.log(`Agents: ${result.agentCount}, Services: ${result.serviceCount}`);
          if (result.agents?.length > 0) {
            console.log("\nAgents:");
            result.agents.forEach(agent => {
              console.log(`  ${agent.agentName} (${agent.identityKey})`);
            });
          }
          if (result.services?.length > 0) {
            console.log("\nServices:");
            result.services.forEach(service => {
              console.log(`  ${service.serviceId} - ${service.name} (${service.pricing?.amountSats || 0} sats) by ${service.agentName}`);
            });
          }
        } catch (error) {
          console.error("Error:", error.message);
        }
      });

    overlay.command("services")
      .description("List our advertised services")
      .action(async () => {
        try {
          const config = pluginConfig;
          const result = await handleServices(buildEnvironment(config), path.join(__dirname, 'scripts', 'overlay-cli.mjs'));
          console.log("Our services:", result);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
    
    overlay.command("setup")
      .description("Run initial wallet setup")
      .action(async () => {
        try {
          const config = pluginConfig;
          const env = buildEnvironment(config);
          const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');
          
          const result = await execFileAsync('node', [cliPath, 'setup'], { env });
          const output = parseCliOutput(result.stdout);
          console.log("Setup result:", output);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
    
    overlay.command("register")
      .description("Register with the overlay network")
      .action(async () => {
        try {
          const config = pluginConfig;
          const env = buildEnvironment(config);
          const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');
          
          const result = await execFileAsync('node', [cliPath, 'register'], { env });
          const output = parseCliOutput(result.stdout);
          console.log("Registration result:", output);
        } catch (error) {
          console.error("Error:", error.message);
        }
      });
  }, { commands: ["overlay"] });

  // Auto-setup: ensure wallet exists (best-effort, non-fatal)
  try {
    const config = pluginConfig;
    const walletDir = config?.walletDir || path.join(process.env.HOME || '', '.clawdbot', 'bsv-wallet');
    const identityFile = path.join(walletDir, 'wallet-identity.json');
    if (!fs.existsSync(identityFile)) {
      api.log?.info?.('[bsv-overlay] No wallet found — running auto-setup...');
      try {
        const env = buildEnvironment(config || {});
        const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');
        await execFileAsync('node', [cliPath, 'setup'], { env });
        api.log?.info?.('[bsv-overlay] Wallet initialized. Fund it and run: overlay({ action: "register" })');
      } catch (err: any) {
        api.log?.warn?.('[bsv-overlay] Auto-setup failed:', err.message);
      }
    }
  } catch (err: any) {
    // Non-fatal — plugin still loads if auto-setup fails
    api.log?.debug?.('[bsv-overlay] Auto-setup skipped:', err.message);
  }
}

async function executeOverlayAction(params, config, api) {
  const { action } = params;
  const env = buildEnvironment(config);
  const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');

  switch (action) {
    case "request":
      return await handleServiceRequest(params, env, cliPath, config, api);
    
    case "discover":
      return await handleDiscover(params, env, cliPath);
    
    case "balance":
      return await handleBalance(env, cliPath);
    
    case "status":
      return await handleStatus(env, cliPath);
    
    case "pay":
      return await handleDirectPay(params, env, cliPath, config);

    case "setup":
      return await handleSetup(env, cliPath);

    case "address":
      return await handleAddress(env, cliPath);

    case "import":
      return await handleImport(params, env, cliPath);

    case "register":
      return await handleRegister(env, cliPath);

    case "advertise":
      return await handleAdvertise(params, env, cliPath);

    case "readvertise":
      return await handleReadvertise(params, env, cliPath);

    case "remove":
      return await handleRemove(params, env, cliPath);

    case "send":
      return await handleSend(params, env, cliPath);

    case "inbox":
      return await handleInbox(env, cliPath);

    case "services":
      return await handleServices(env, cliPath);

    case "refund":
      return await handleRefund(params, env, cliPath);

    case "onboard":
      return await handleOnboard(env, cliPath);
    
    case "pending-requests":
      return await handlePendingRequests(env, cliPath);
    
    case "fulfill":
      return await handleFulfill(params, env, cliPath);
    
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function handleServiceRequest(params, env, cliPath, config, api) {
  const { service, input, maxPrice } = params;
  const walletDir = config?.walletDir || path.join(process.env.HOME || '', '.clawdbot', 'bsv-wallet');
  
  if (!service) {
    throw new Error("Service is required for request action");
  }

  // 1. Discover providers for the service
  const discoverResult = await execFileAsync('node', [cliPath, 'discover', '--service', service], { env });
  const discoverOutput = parseCliOutput(discoverResult.stdout);
  
  if (!discoverOutput.success) {
    throw new Error(`Discovery failed: ${discoverOutput.error}`);
  }

  // FIX: Use discoverOutput.data.services instead of treating data as flat array
  const providers = discoverOutput.data.services;
  if (!providers || providers.length === 0) {
    throw new Error(`No providers found for service: ${service}`);
  }

  // 2. Filter out our own identity key
  const identityResult = await execFileAsync('node', [cliPath, 'identity'], { env });
  const identityOutput = parseCliOutput(identityResult.stdout);
  const ourKey = identityOutput.data?.identityKey;
  
  const externalProviders = providers.filter(p => p.identityKey !== ourKey);
  if (externalProviders.length === 0) {
    throw new Error("No external providers available (only found our own services)");
  }

  // 3. Sort by price - FIX: Use pricing.amountSats instead of pricingSats
  externalProviders.sort((a, b) => (a.pricing?.amountSats || 0) - (b.pricing?.amountSats || 0));
  
  const bestProvider = externalProviders[0];
  const price = bestProvider.pricing?.amountSats || 0;

  // 4. Check price limits
  const maxAutoPaySats = config.maxAutoPaySats || 200;
  const userMaxPrice = maxPrice || maxAutoPaySats;
  
  if (price > userMaxPrice) {
    throw new Error(`Service price (${price} sats) exceeds limit (${userMaxPrice} sats)`);
  }

  // 5. Check daily budget
  const dailyLimit = config.dailyBudgetSats || 1000;
  const budgetCheck = checkBudget(walletDir, price, dailyLimit);
  if (!budgetCheck.allowed) {
    throw new Error(`Service request would exceed daily budget. Spent: ${budgetCheck.spent} sats, Remaining: ${budgetCheck.remaining} sats, Requested: ${price} sats. Please confirm with user.`);
  }

  api.logger.info(`Requesting service ${service} from ${bestProvider.agentName} for ${price} sats`);

  // 6. Request the service
  const requestArgs = [cliPath, 'request-service', bestProvider.identityKey, service, price.toString()];
  if (input) {
    requestArgs.push(JSON.stringify(input));
  }
  
  const requestResult = await execFileAsync('node', requestArgs, { env });
  const requestOutput = parseCliOutput(requestResult.stdout);
  
  if (!requestOutput.success) {
    throw new Error(`Service request failed: ${requestOutput.error}`);
  }

  // 7. Poll for response
  const maxPollAttempts = 12; // ~60 seconds with 5 second intervals
  let attempts = 0;
  
  while (attempts < maxPollAttempts) {
    await sleep(5000); // Wait 5 seconds
    attempts++;
    
    try {
      const pollResult = await execFileAsync('node', [cliPath, 'poll'], { env });
      const pollOutput = parseCliOutput(pollResult.stdout);
      
      if (pollOutput.success && pollOutput.data) {
        // FIX: Check pollOutput.data.messages array for service-response
        const messages = pollOutput.data.messages || [];
        for (const msg of messages) {
          if (msg.type === 'service-response' && msg.from === bestProvider.identityKey) {
            api.logger.info(`Received response from ${bestProvider.agentName}`);
            // Record the spending
            recordSpend(walletDir, price, service, bestProvider.agentName);
            return {
              provider: bestProvider.agentName,
              cost: price,
              result: msg.payload
            };
          }
        }
      }
    } catch (pollError) {
      // Continue polling even if one poll fails
      api.logger.warn(`Poll attempt ${attempts} failed: ${pollError.message}`);
    }
  }
  
  throw new Error(`Service request timed out after ${maxPollAttempts * 5} seconds`);
}

async function handleDiscover(params, env, cliPath) {
  const { service, agent } = params;
  const args = [cliPath, 'discover'];
  
  if (service) {
    args.push('--service', service);
  }
  if (agent) {
    args.push('--agent', agent);
  }
  
  const result = await execFileAsync('node', args, { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Discovery failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleBalance(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'balance'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Balance check failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleStatus(env, cliPath) {
  try {
    // Get identity
    const identityResult = await execFileAsync('node', [cliPath, 'identity'], { env });
    const identity = parseCliOutput(identityResult.stdout);
    
    // Get balance
    const balanceResult = await execFileAsync('node', [cliPath, 'balance'], { env });
    const balance = parseCliOutput(balanceResult.stdout);
    
    // Get services
    const servicesResult = await execFileAsync('node', [cliPath, 'services'], { env });
    const services = parseCliOutput(servicesResult.stdout);
    
    return {
      identity: identity.data,
      balance: balance.data,
      services: services.data
    };
  } catch (error) {
    throw new Error(`Status check failed: ${error.message}`);
  }
}

async function handleDirectPay(params, env, cliPath, config) {
  const { identityKey, sats, description } = params;
  const walletDir = config?.walletDir || path.join(process.env.HOME || '', '.clawdbot', 'bsv-wallet');
  
  if (!identityKey || !sats) {
    throw new Error("identityKey and sats are required for pay action");
  }

  // Check daily budget
  const dailyLimit = config?.dailyBudgetSats || 1000;
  const budgetCheck = checkBudget(walletDir, sats, dailyLimit);
  if (!budgetCheck.allowed) {
    throw new Error(`Payment would exceed daily budget. Spent: ${budgetCheck.spent} sats, Remaining: ${budgetCheck.remaining} sats, Requested: ${sats} sats. Please confirm with user.`);
  }
  
  const args = [cliPath, 'pay', identityKey, sats.toString()];
  if (description) {
    args.push(description);
  }
  
  const result = await execFileAsync('node', args, { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Payment failed: ${output.error}`);
  }

  // Record the spending
  recordSpend(walletDir, sats, 'direct-payment', identityKey);
  
  return output.data;
}

async function handleSetup(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'setup'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Setup failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleAddress(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'address'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Address failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleImport(params, env, cliPath) {
  const { txid, vout } = params;
  
  if (!txid) {
    throw new Error("txid is required for import action");
  }
  
  const args = [cliPath, 'import', txid];
  if (vout !== undefined) {
    args.push(vout.toString());
  }
  
  const result = await execFileAsync('node', args, { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Import failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleRegister(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'register'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Registration failed: ${output.error}`);
  }
  
  return {
    ...output.data,
    registered: true,
    availableServices: [
      { serviceId: "tell-joke", name: "Random Joke", description: "Get a random joke", suggestedPrice: 5 },
      { serviceId: "code-review", name: "Code Review", description: "Review code for bugs, security, and style", suggestedPrice: 50 },
      { serviceId: "web-research", name: "Web Research", description: "Research a topic using web sources", suggestedPrice: 50 },
      { serviceId: "translate", name: "Translation", description: "Translate text between languages", suggestedPrice: 20 },
      { serviceId: "api-proxy", name: "API Proxy", description: "Proxy requests to public APIs", suggestedPrice: 15 },
      { serviceId: "roulette", name: "Roulette", description: "Casino-style roulette game", suggestedPrice: 10 },
      { serviceId: "memory-store", name: "Memory Store", description: "Key-value storage for agents", suggestedPrice: 10 },
      { serviceId: "code-develop", name: "Code Development", description: "Generate code from requirements", suggestedPrice: 100 }
    ],
    nextStep: "Choose which services to advertise. Call overlay({ action: 'advertise', ... }) for each."
  };
}

async function handleAdvertise(params, env, cliPath) {
  const { serviceId, name, description, priceSats } = params;
  
  if (!serviceId || !name || !description || priceSats === undefined) {
    throw new Error("serviceId, name, description, and priceSats are required for advertise action");
  }
  
  const result = await execFileAsync('node', [cliPath, 'advertise', serviceId, name, description, priceSats.toString()], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Advertise failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleReadvertise(params, env, cliPath) {
  const { serviceId, newPrice, newName, newDesc } = params;
  
  if (!serviceId || newPrice === undefined) {
    throw new Error("serviceId and newPrice are required for readvertise action");
  }
  
  const args = [cliPath, 'readvertise', serviceId, newPrice.toString()];
  if (newName) {
    args.push(newName);
  }
  if (newDesc) {
    args.push(newDesc);
  }
  
  const result = await execFileAsync('node', args, { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Readvertise failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleRemove(params, env, cliPath) {
  const { serviceId } = params;
  
  if (!serviceId) {
    throw new Error("serviceId is required for remove action");
  }
  
  const result = await execFileAsync('node', [cliPath, 'remove', serviceId], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Remove failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleSend(params, env, cliPath) {
  const { identityKey, messageType, payload } = params;
  
  if (!identityKey || !messageType || !payload) {
    throw new Error("identityKey, messageType, and payload are required for send action");
  }
  
  const result = await execFileAsync('node', [cliPath, 'send', identityKey, messageType, JSON.stringify(payload)], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Send failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleInbox(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'inbox'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Inbox failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleServices(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'services'], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Services failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleRefund(params, env, cliPath) {
  const { address } = params;
  
  if (!address) {
    throw new Error("address is required for refund action");
  }
  
  const result = await execFileAsync('node', [cliPath, 'refund', address], { env });
  const output = parseCliOutput(result.stdout);
  
  if (!output.success) {
    throw new Error(`Refund failed: ${output.error}`);
  }
  
  return output.data;
}

async function handleOnboard(env, cliPath) {
  const steps = [];
  
  // Step 1: Setup wallet
  try {
    const setup = await execFileAsync('node', [cliPath, 'setup'], { env });
    const setupOutput = parseCliOutput(setup.stdout);
    steps.push({ step: 'setup', success: true, identityKey: setupOutput.data?.identityKey });
  } catch (err) {
    steps.push({ step: 'setup', success: false, error: err.message });
    return { steps, nextStep: 'Fix wallet setup error and try again' };
  }
  
  // Step 2: Get address
  try {
    const addr = await execFileAsync('node', [cliPath, 'address'], { env });
    const addrOutput = parseCliOutput(addr.stdout);
    steps.push({ step: 'address', success: true, address: addrOutput.data?.address });
  } catch (err) {
    steps.push({ step: 'address', success: false, error: err.message });
  }
  
  // Step 3: Check balance
  try {
    const bal = await execFileAsync('node', [cliPath, 'balance'], { env });
    const balOutput = parseCliOutput(bal.stdout);
    const balance = balOutput.data?.walletBalance || balOutput.data?.onChain?.confirmed || 0;
    steps.push({ step: 'balance', success: true, balance });
    
    if (balance < 1000) {
      return {
        steps,
        funded: false,
        nextStep: `Fund your wallet with at least 1,000 sats. Send BSV to: ${steps[1]?.address}. Auto-import is running — once funded, run overlay({ action: "onboard" }) again.`
      };
    }
  } catch (err) {
    steps.push({ step: 'balance', success: false, error: err.message });
  }
  
  // Step 4: Register
  try {
    const reg = await execFileAsync('node', [cliPath, 'register'], { env, timeout: 60000 });
    const regOutput = parseCliOutput(reg.stdout);
    steps.push({ step: 'register', success: regOutput.success, data: regOutput.data });
  } catch (err) {
    steps.push({ step: 'register', success: false, error: err.message });
  }
  
  return {
    steps,
    funded: true,
    registered: true,
    availableServices: [
      { serviceId: "tell-joke", name: "Random Joke", description: "Get a random joke", suggestedPrice: 5 },
      { serviceId: "code-review", name: "Code Review", description: "Review code for bugs, security, and style", suggestedPrice: 50 },
      { serviceId: "web-research", name: "Web Research", description: "Research a topic using web sources", suggestedPrice: 50 },
      { serviceId: "translate", name: "Translation", description: "Translate text between languages", suggestedPrice: 20 },
      { serviceId: "api-proxy", name: "API Proxy", description: "Proxy requests to public APIs", suggestedPrice: 15 },
      { serviceId: "roulette", name: "Roulette", description: "Casino-style roulette game", suggestedPrice: 10 },
      { serviceId: "memory-store", name: "Memory Store", description: "Key-value storage for agents", suggestedPrice: 10 },
      { serviceId: "code-develop", name: "Code Development", description: "Generate code from requirements", suggestedPrice: 100 }
    ],
    nextStep: "Choose which services to advertise. Call overlay({ action: 'advertise', ... }) for each.",
    message: 'Onboarding complete! Your agent is registered on the BSV overlay network. The background service will handle incoming requests.'
  };
}

async function handlePendingRequests(env, cliPath) {
  const result = await execFileAsync('node', [cliPath, 'service-queue'], { env });
  const output = parseCliOutput(result.stdout);
  if (!output.success) throw new Error(`Queue check failed: ${output.error}`);
  return output.data;
}

async function handleFulfill(params, env, cliPath) {
  const { requestId, recipientKey, serviceId, result } = params;
  if (!requestId || !recipientKey || !serviceId || !result) {
    throw new Error("requestId, recipientKey, serviceId, and result are required");
  }
  
  const cliResult = await execFileAsync('node', [
    cliPath, 'respond-service', requestId, recipientKey, serviceId, JSON.stringify(result)
  ], { env });
  const output = parseCliOutput(cliResult.stdout);
  if (!output.success) throw new Error(`Fulfill failed: ${output.error}`);
  return output.data;
}

function buildEnvironment(config) {
  const env = { ...process.env };
  
  if (config.walletDir) {
    env.BSV_WALLET_DIR = config.walletDir;
  }
  if (config.overlayUrl) {
    env.OVERLAY_URL = config.overlayUrl;
  }
  
  // Set defaults
  env.BSV_NETWORK = env.BSV_NETWORK || 'mainnet';
  env.AGENT_NAME = env.AGENT_NAME || 'clawdbot-agent';
  env.AGENT_ROUTED = 'true'; // Route service requests through the agent
  
  return env;
}

function parseCliOutput(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Failed to parse CLI output: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}