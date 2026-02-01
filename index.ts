import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

// Track background process for proper lifecycle management
let backgroundProcess: any = null;

export default function register(api) {
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
            "readvertise", "remove", "send", "inbox", "services", "refund"
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
        }
      },
      required: ["action"]
    },
    async execute(id, params) {
      const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
      
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
        const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
        const env = buildEnvironment(config);
        const cliPath = path.join(__dirname, 'scripts', 'overlay-cli.mjs');
        
        // Start the WebSocket connection using spawn instead of execFile
        backgroundProcess = spawn('node', [cliPath, 'connect'], { 
          env,
          stdio: 'pipe',
          detached: false
        });

        backgroundProcess.stdout?.on('data', (data) => {
          try {
            const output = JSON.parse(data.toString().trim());
            if (output.event) {
              api.logger.info(`BSV relay event: ${output.event}`, output);
            }
          } catch (e) {
            api.logger.debug(`BSV relay output: ${data.toString().trim()}`);
          }
        });

        backgroundProcess.stderr?.on('data', (data) => {
          api.logger.warn(`BSV relay stderr: ${data.toString().trim()}`);
        });

        backgroundProcess.on('close', (code) => {
          api.logger.info(`BSV relay process exited with code ${code}`);
          backgroundProcess = null;
        });

        backgroundProcess.on('error', (error) => {
          api.logger.error(`BSV relay process error: ${error.message}`);
          backgroundProcess = null;
        });

        api.logger.info("BSV overlay WebSocket relay started");
      } catch (error) {
        api.logger.error(`Failed to start BSV overlay relay: ${error.message}`);
        backgroundProcess = null;
      }
    },
    stop: async () => {
      api.logger.info("Stopping BSV overlay WebSocket relay...");
      if (backgroundProcess) {
        backgroundProcess.kill('SIGTERM');
        // Give it a moment to close gracefully
        setTimeout(() => {
          if (backgroundProcess && !backgroundProcess.killed) {
            backgroundProcess.kill('SIGKILL');
          }
        }, 2000);
        backgroundProcess = null;
      }
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
          const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
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
          const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
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
          const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
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
          const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
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
          const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
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
          const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
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
          const config = api.getConfig()?.plugins?.entries?.['bsv-overlay']?.config || {};
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
      return await handleDirectPay(params, env, cliPath);

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
    
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function handleServiceRequest(params, env, cliPath, config, api) {
  const { service, input, maxPrice } = params;
  
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

  api.logger.info(`Requesting service ${service} from ${bestProvider.agentName} for ${price} sats`);

  // 5. Request the service
  const requestArgs = [cliPath, 'request-service', bestProvider.identityKey, service, price.toString()];
  if (input) {
    requestArgs.push(JSON.stringify(input));
  }
  
  const requestResult = await execFileAsync('node', requestArgs, { env });
  const requestOutput = parseCliOutput(requestResult.stdout);
  
  if (!requestOutput.success) {
    throw new Error(`Service request failed: ${requestOutput.error}`);
  }

  // 6. Poll for response
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

async function handleDirectPay(params, env, cliPath) {
  const { identityKey, sats, description } = params;
  
  if (!identityKey || !sats) {
    throw new Error("identityKey and sats are required for pay action");
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
  
  return output.data;
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