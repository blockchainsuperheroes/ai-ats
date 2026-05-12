require("dotenv").config();
const express = require("express");
const { Wallet, providers, utils, Contract } = require("ethers");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.set("trust proxy", true);
app.use(express.json());
const speedRoutes = require("./speed-routes");
speedRoutes(app);
const recalcSpeedBonus = speedRoutes.recalcSpeedBonus;

const DATA_FILE = "/var/www/ats/data/agents.json";
const IP_FILE = "/var/www/ats/data/ips.json";
const SIGNUP_LOG = "/var/www/ats/data/signup-log.jsonl";

// Get real client IP (trust proxy is set, so req.ip works, but belt-and-suspenders)
function getIP(req) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return xff.split(",")[0].trim();
    return req.headers["x-real-ip"] || req.ip || "unknown";
}

// Append-only signup log for analysis
function logSignup(action, req, username, extra) {
    try {
        const entry = JSON.stringify({
            t: Date.now(),
            action,
            ip: getIP(req),
            ua: (req.headers["user-agent"] || "").slice(0, 200),
            username: username || "",
            ...extra
        }) + "\n";
        fs.appendFileSync(SIGNUP_LOG, entry);
    } catch (e) { /* non-critical */ }
}

// Per-IP daily rate limit for L1 signups (anti-bot)
const IP_SIGNUP_LIMIT = 10; // max new registrations per IP per day
function checkSignupLimit(ip) {
    const ips = loadData(IP_FILE);
    const now = Date.now();
    const dayAgo = now - 86400000;
    // Clean old entries
    if (ips[ip] && typeof ips[ip] === "object" && ips[ip].resets && ips[ip].resets < dayAgo) {
        delete ips[ip];
    }
    // Legacy format: ips[ip] was just a timestamp. Migrate.
    if (ips[ip] && typeof ips[ip] === "number") {
        ips[ip] = { count: 1, resets: ips[ip] + 86400000 };
    }
    if (!ips[ip]) {
        ips[ip] = { count: 0, resets: now + 86400000 };
    }
    ips[ip].count++;
    saveData(IP_FILE, ips);
    return ips[ip].count <= IP_SIGNUP_LIMIT;
}

// Ensure data dir exists
if (!fs.existsSync("/var/www/ats/data")) {
    fs.mkdirSync("/var/www/ats/data", { recursive: true });
}

// ── Challenge-response system (anti-bot reading comprehension) ──
const challenges = new Map();
const challengeCooldowns = new Map();
const CHALLENGE_TTL = 60000; // 60 seconds to answer
const CHALLENGE_COOLDOWN = 10000; // 10 seconds between challenges per IP

// Clean expired challenges every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of challenges) {
        if (data.expires < now) challenges.delete(token);
    }
    for (const [ip, t] of challengeCooldowns) {
        if (t + CHALLENGE_COOLDOWN < now) challengeCooldowns.delete(ip);
    }
}, 300000);

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateChallenge() {
    const names = ["Nova", "Atlas", "Iris", "Cipher", "Echo", "Drift", "Pulse", "Sage", "Vertex", "Onyx",
        "Helix", "Prism", "Neon", "Spark", "Ghost", "Frost", "Blaze", "Storm", "Lux", "Shade"];
    const cities = ["Tokyo", "Seoul", "Berlin", "Lagos", "Dubai", "London", "Mumbai", "Jakarta", "Cairo",
        "Lima", "Taipei", "Nairobi", "Helsinki", "Bangkok", "Lisbon", "Bogota", "Hanoi", "Oslo", "Accra", "Kyoto"];
    const networks = ["Ethereum", "Solana", "Polygon", "Arbitrum", "Optimism", "Avalanche", "Base",
        "Pentagon Chain", "BNB Chain", "Fantom", "zkSync", "Starknet", "Cosmos", "Near", "Sui"];
    const tasks = ["monitoring wallets", "scanning mempools", "analyzing trades", "indexing blocks",
        "managing portfolios", "tracking gas prices", "verifying contracts", "routing swaps",
        "aggregating feeds", "bridging assets", "auditing protocols", "compiling reports"];
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const colors = ["red", "blue", "green", "purple", "orange", "silver", "gold", "white", "black", "cyan"];

    const name = pick(names);
    const city = pick(cities);
    const network = pick(networks);
    const task = pick(tasks);
    const day = pick(days);
    const color = pick(colors);
    const count = Math.floor(Math.random() * 47) + 3;

    const paragraph = `Agent ${name} was deployed in ${city} on a ${day}. It operates on the ${network} network and is primarily responsible for ${task}. Currently it manages ${count} active connections and its status indicator is ${color}.`;

    const pool = [
        { q: `What city is ${name} deployed in?`, a: city.toLowerCase() },
        { q: `What network does ${name} operate on?`, a: network.toLowerCase() },
        { q: `What day was ${name} deployed?`, a: day.toLowerCase() },
        { q: `How many active connections does ${name} manage? (number only)`, a: String(count) },
        { q: `What is ${name} primarily responsible for?`, a: task.toLowerCase() },
        { q: `What color is ${name}'s status indicator?`, a: color.toLowerCase() },
    ];

    const picked = pick(pool);
    return { paragraph, question: picked.q, answer: picked.a };
}

// Load/save helpers
function loadData(file, def = {}) {
    try { return JSON.parse(fs.readFileSync(file)); } catch { return def; }
}
function saveData(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// PC Chain setup (auth RPC for reliable receipt polling)
const provider = new providers.JsonRpcProvider("https://rpc.pentagon.games/rpc/GLuLMOVEM0ANn4Wj6oVgSqcbEeshwSDj9");
const faucetWallet = new Wallet(process.env.FAUCET_PRIVATE, provider);
const DRIP_AMOUNT = utils.parseEther("0.001");
const FAUCET_CONTRACT = "0xd9078a82fdce91632dd6b6749e9ac0932095f49a";
const faucetABI = ["function drip(address) external", "function balance() view returns (uint256)", "function canClaim(address) view returns (bool)", "function timeUntilClaim(address) view returns (uint256)"];
const faucetContract = new Contract(FAUCET_CONTRACT, faucetABI, faucetWallet);

// Agent vs Human classification based on total completion time
// These thresholds are based on observed completion patterns:
// - Agents complete L1→L3 in seconds to low minutes (API calls + cast send)
// - Humans need to read, click, sign MetaMask popups, copy-paste = minutes to hours
function classify(agent) {
    // Determine highest level reached
    let level = 0;
    if (agent.l1) level = 1;
    if (agent.l2 && agent.l2.verified) level = 2;
    if (agent.l3 && agent.l3.verified) level = 3;
    if (agent.l4 && agent.l4.verified) level = 4;
    
    // L2-only: never proved on-chain capability. Soft callout.
    if (level <= 2) {
        return { 
            classification: "unverified", 
            totalSecs: 0, 
            confidence: "high",
            status: "Certification incomplete. L3 on-chain proof required.",
            agentic: false
        };
    }
    
    // Calculate total time from server timestamps (L1 submit → highest completed level)
    let totalSecs = 0;
    const times = agent.serverSpeedTimes || {};
    if (times.l1_to_l2) totalSecs += times.l1_to_l2;
    if (times.l2_to_l3) totalSecs += times.l2_to_l3;
    if (times.l3_to_l4) totalSecs += times.l3_to_l4;
    
    // Fallback: use client-reported totalTime if no server times
    if (totalSecs === 0 && agent.totalTime) totalSecs = agent.totalTime;
    
    // Not enough data yet
    if (totalSecs === 0) return { classification: "unknown", totalSecs: 0, confidence: "low", agentic: true };
    
    // Classification thresholds
    if (totalSecs < 60)        return { classification: "agent", totalSecs, confidence: "high", agentic: true };
    if (totalSecs < 180)       return { classification: "agent", totalSecs, confidence: "medium", agentic: true };
    if (totalSecs < 300)       return { classification: "likely-agent", totalSecs, confidence: "medium", agentic: true };
    if (totalSecs < 600)       return { classification: "likely-human", totalSecs, confidence: "medium", agentic: false };
    return                            { classification: "human", totalSecs, confidence: "high", agentic: false };
}

// Pentagon Chain info for API responses
const CHAIN_INFO = {
    name: "Pentagon Chain",
    chainId: 3344,
    rpc: "https://rpc.pentagon.games",
    explorer: "https://explorer.pentagon.games",
    symbol: "PC",
    addToWallet: {
        networkName: "Pentagon Chain",
        rpcUrl: "https://rpc.pentagon.games",
        chainId: 3344,
        symbol: "PC",
        explorer: "https://explorer.pentagon.games"
    }
};

// Step guide for agents
const STEPS = {
    challenge: "GET /api/challenge — Receive a reading comprehension question and token (required for L1)",
    l1: "POST /api/verify-l1 with {username, postUrl, challengeToken, challengeAnswer}",
    l2: "POST /api/verify-l2 with {username, wallet, signature, message}",
    drip: "POST /api/drip with {username} — Claim free 0.001 PC gas",
    l3: "POST /api/verify-l3 with {username, txHash} — Send any TX on Pentagon Chain (chainId 3344, RPC: https://rpc.pentagon.games)",
    l4: "Visit /l4-mint in a real browser (JavaScript required for daily code)"
};


// Rate limiting by IP
function checkIP(ip) {
    const ips = loadData(IP_FILE);
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    if (ips[ip] && ips[ip] > dayAgo) return false;
    ips[ip] = now;
    saveData(IP_FILE, ips);
    return true;
}

// ── Challenge endpoint (GET /api/challenge) ──
app.get("/api/challenge", (req, res) => {
    const ip = getIP(req);

    // Per-IP cooldown
    const lastChallenge = challengeCooldowns.get(ip) || 0;
    if (Date.now() - lastChallenge < CHALLENGE_COOLDOWN) {
        const wait = Math.ceil((CHALLENGE_COOLDOWN - (Date.now() - lastChallenge)) / 1000);
        return res.status(429).json({ error: "Too fast. Wait " + wait + "s before requesting another challenge.", retryAfter: wait });
    }

    const { paragraph, question, answer } = generateChallenge();
    const token = crypto.randomBytes(24).toString("hex");

    challenges.set(token, { answer, ip, expires: Date.now() + CHALLENGE_TTL });
    challengeCooldowns.set(ip, Date.now());

    res.json({
        challengeToken: token,
        expiresIn: "60s",
        paragraph,
        question,
        hint: "Read the paragraph, answer the question, then POST /api/verify-l1 with {username, postUrl, challengeToken, challengeAnswer}."
    });
});

// Verify L1 (challenge-response + Moltbook)
app.post("/api/verify-l1", (req, res) => {
    const { username, postUrl, challengeToken, challengeAnswer } = req.body;
    const ip = getIP(req);
    
    if (!username || !postUrl) {
        return res.status(400).json({ error: "Missing username or postUrl", hint: "First GET /api/challenge to receive a reading question and token, then POST here with {username, postUrl, challengeToken, challengeAnswer}.", steps: STEPS });
    }

    if (!challengeToken || !challengeAnswer) {
        return res.status(400).json({ error: "Missing challengeToken or challengeAnswer. GET /api/challenge first to receive a question.", steps: STEPS });
    }

    // Validate challenge token
    const challenge = challenges.get(challengeToken);
    if (!challenge) {
        return res.status(400).json({ error: "Invalid or expired challenge token. GET /api/challenge for a new one." });
    }
    if (challenge.expires < Date.now()) {
        challenges.delete(challengeToken);
        return res.status(400).json({ error: "Challenge expired. GET /api/challenge for a new one." });
    }
    // Single-use: delete immediately
    challenges.delete(challengeToken);

    // Flexible answer matching: trim, lowercase, check if answer contains the expected value
    const given = challengeAnswer.toString().trim().toLowerCase();
    const expected = challenge.answer;
    if (given !== expected && !given.includes(expected)) {
        logSignup("l1-challenge-failed", req, username, { given, expected });
        return res.status(400).json({ error: "Incorrect answer. GET /api/challenge for a new question." });
    }
    
    // Rate limit signups per IP
    if (!checkSignupLimit(ip)) {
        logSignup("l1-ratelimited", req, username);
        return res.status(429).json({ error: "Too many registrations from this IP. Try again tomorrow.", limit: IP_SIGNUP_LIMIT });
    }
    
    const agents = loadData(DATA_FILE);
    const id = username.toLowerCase().replace(/[^a-z0-9]/g, "");

    // Block re-submission if L1 already completed
    if (agents[id] && agents[id].l1) {
        return res.json({ success: true, message: "L1 already completed.", agentId: id, certUrl: "/cert/" + id, verifyUrl: "/api/agent/" + id, username: agents[id].username, next: STEPS.l2 });
    }
    
    if (!agents[id]) {
        agents[id] = { username, created: Date.now() };
    }
    
    agents[id].l1 = { postUrl, verified: false, submitted: Date.now(), ip };
    saveData(DATA_FILE, agents);
    logSignup("l1", req, username, { id });
    
    res.json({ success: true, message: "L1 ECHO submitted!", agentId: id, certUrl: "/cert/" + id, verifyUrl: "/api/agent/" + id, username: agents[id].username, next: STEPS.l2 });
});

// Verify L2 (Wallet signature)
app.post("/api/verify-l2", async (req, res) => {
    const { username, wallet, signature, message } = req.body;
    const ip = getIP(req);
    
    if (!username || !wallet || !signature || !message) {
        return res.status(400).json({ error: "Missing fields" });
    }
    
    // Check for duplicate wallet (same wallet used by different agent)
    const agents_check = loadData(DATA_FILE);
    const thisId = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const walletLower = wallet.toLowerCase();
    for (const [existingId, existingAgent] of Object.entries(agents_check)) {
        if (existingId !== thisId && existingAgent.l2 && existingAgent.l2.wallet && existingAgent.l2.wallet.toLowerCase() === walletLower) {
            logSignup("l2-duplicate-wallet", req, username, { wallet, existingAgent: existingId });
            return res.status(400).json({ error: "This wallet is already registered by another agent. Each agent needs its own wallet.", existingAgent: existingAgent.username });
        }
    }
    
    // Verify signature
    try {
        const recovered = utils.verifyMessage(message, signature);
        if (recovered.toLowerCase() !== wallet.toLowerCase()) {
            return res.status(400).json({ error: "Invalid signature" });
        }
    } catch (e) {
        return res.status(400).json({ error: "Signature verification failed" });
    }
    
    const agents = loadData(DATA_FILE);
    const id = username.toLowerCase().replace(/[^a-z0-9]/g, "");

    // Block re-submission if L2 already completed
    if (agents[id] && agents[id].l2 && agents[id].l2.verified) {
        return res.json({ success: true, message: "L2 already completed.", certUrl: "/cert/" + id, next: STEPS.drip });
    }
    
    if (!agents[id]) {
        agents[id] = { username, created: Date.now() };
    }
    
    agents[id].l2 = { wallet, verified: true, timestamp: Date.now(), ip };
    // Recalc speed bonus from server timestamps
    const { bonus: l2Bonus, times: l2Times } = recalcSpeedBonus(agents[id]);
    if (l2Bonus > (agents[id].speedBonus || 0)) { agents[id].speedBonus = l2Bonus; }
    agents[id].serverSpeedTimes = l2Times;
    saveData(DATA_FILE, agents);
    logSignup("l2", req, username, { id, wallet });
    
    res.json({ success: true, message: "L2 TOOL verified!", speedBonus: agents[id].speedBonus || 0, certUrl: "/cert/" + id, next: STEPS.drip, hint: "Claim your free gas, then send a TX on Pentagon Chain for L3." });
});

// Drip faucet for L2 verified
app.post("/api/drip", async (req, res) => {
    const { username } = req.body;
    const ip = getIP(req);
    
    const agents = loadData(DATA_FILE);
    const id = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const agent = agents[id];
    
    if (!agent || !agent.l2 || !agent.l2.verified) {
        return res.status(400).json({ error: "Complete L2 verification first.", next: "POST /api/verify-l2 with {username, wallet, signature, message}", steps: STEPS });
    }
    
    if (agent.dripped) {
        return res.status(400).json({ error: "Already received drip", chain: CHAIN_INFO, next: STEPS.l3, hint: "You already have gas. Send a TX on Pentagon Chain (chainId 3344, RPC: https://rpc.pentagon.games) and submit the hash to /api/verify-l3." });
    }
    
    if (!checkIP(ip)) {
        return res.status(429).json({ error: "Rate limited: 1 lobster per household per day 🦞 Check if another agent on your network already claimed today. Try again tomorrow!" });
    }
    
    try {
        const tx = await faucetContract.drip(agent.l2.wallet);
        await tx.wait();
        
        agent.dripped = { tx: tx.hash, timestamp: Date.now() };
        
        res.json({ success: true, tx: tx.hash, amount: "0.001 PC", chain: CHAIN_INFO, explorer: "https://explorer.pentagon.games/tx/" + tx.hash, next: STEPS.l3, hint: "You now have 0.001 PC on Pentagon Chain (chainId 3344). Send any TX from your wallet using RPC https://rpc.pentagon.games then submit the hash to /api/verify-l3." });
    } catch (e) {
        res.status(500).json({ error: "Drip failed: " + e.message });
    }
});

// Public stats / funnel endpoint (MUST be before /api/agent/:id to avoid catch-all)
app.get("/api/stats", (req, res) => {
    try {
        const agents = loadData(DATA_FILE);
        const all = Object.values(agents);
        const today = new Date().toISOString().split("T")[0];
        
        const l1 = all.filter(a => a.l1).length;
        const l2 = all.filter(a => a.l2 && a.l2.verified).length;
        const dripped = all.filter(a => a.dripped).length;
        const l3 = all.filter(a => a.l3 && a.l3.verified).length;
        const l4 = all.filter(a => a.l4 && a.l4.verified).length;
        
        const certified = all.filter(a => a.l3 && a.l3.verified);
        let autonomous = 0, humanAssisted = 0;
        certified.forEach(a => {
            try {
                const c = classify(a);
                if (c.classification === "agent" || c.classification === "likely-agent") autonomous++;
                if (c.classification === "human" || c.classification === "likely-human") humanAssisted++;
            } catch (e) { /* skip */ }
        });
        
        const todaySignups = all.filter(a => a.created && new Date(a.created).toISOString().split("T")[0] === today).length;
        
        
        res.json({
            totalRegistered: all.length,
            walletVerified: l2,
            today: { signups: todaySignups },
            message: all.length + " agents registered. " + l2 + " wallet-verified."
        });
    } catch (e) {
        res.status(500).json({ error: "Stats failed: " + e.message });
    }
});

// Get agent cert data (auto-syncs on-chain badge status)
app.get("/api/agent/:id", async (req, res) => {
    const agents = loadData(DATA_FILE);
    const id = req.params.id.toLowerCase();
    const agent = agents[id];
    
    if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
    }
    
    // Auto-sync: check on-chain badge status if agent has a wallet
    let synced = false;
    if (agent.l2 && agent.l2.verified && agent.l2.wallet) {
        try {
            const ATS_CERT = "0xcbe0847822211e5e7162E910e81bdE1723cbd310";
            const erc1155ABI = [
                "function balanceOf(address account, uint256 id) view returns (uint256)",
                "function highestTier(address) view returns (uint256)"
            ];
            const certContract = new Contract(ATS_CERT, erc1155ABI, provider);
            const onChainTier = await certContract.highestTier(agent.l2.wallet);
            const tier = onChainTier.toNumber();
            
            // Sync L3 if on-chain but not in backend
            if (tier >= 3 && !agent.l3) {
                agent.l3 = { verified: true, timestamp: Date.now(), autoSynced: true };
                const { bonus, times } = recalcSpeedBonus(agent);
                if (bonus > (agent.speedBonus || 0)) agent.speedBonus = bonus;
                agent.serverSpeedTimes = times;
                synced = true;
            }
            
            // Sync L4 if on-chain but not in backend
            if (tier >= 4 && !agent.l4) {
                agent.l4 = { verified: true, timestamp: Date.now(), autoSynced: true };
                const { bonus, times } = recalcSpeedBonus(agent);
                if (bonus > (agent.speedBonus || 0)) agent.speedBonus = bonus;
                agent.serverSpeedTimes = times;
                synced = true;
            }
            
            if (synced) saveData(DATA_FILE, agents);
        } catch (e) {
            // On-chain check failed, serve cached data (don't block the response)
        }
    }
    
    const cls = classify(agent);
    
    res.json({
        username: agent.username,
        classification: cls.classification,
        classificationConfidence: cls.confidence,
        l1: agent.l1 ? { verified: agent.l1.verified, submitted: agent.l1.submitted } : null,
        l2: agent.l2 ? { verified: agent.l2.verified, wallet: agent.l2.wallet } : null,
        l3: agent.l3 || null,
        l4: agent.l4 || null,
        dripped: !!agent.dripped,
        v1Level: agent.v1Level || 0,
        v3Level: agent.v3Level || 0,
        speedBonus: agent.speedBonus || 0,
        totalTime: cls.totalSecs || agent.totalTime || 0,
        serverSpeedTimes: agent.serverSpeedTimes || {},
        levelTimes: agent.levelTimes || {},
        synced: synced || undefined
    });
});

// Faucet balance check
app.get("/api/faucet", async (req, res) => {
    const contractBalance = await provider.getBalance(FAUCET_CONTRACT);
    
    res.json({
        address: FAUCET_CONTRACT,
        balance: utils.formatEther(contractBalance) + " PC",
        note: "Faucet is contract-managed. Max 0.001 PC per address per day."
    });
});

const PORT = 3000;
// L4 verification endpoint
app.post("/api/verify-l4", (req, res) => {
    const { username, code, speedBonus, totalTime } = req.body;
    const now = new Date();
    const ds = now.getUTCFullYear() + "-" + (now.getUTCMonth()+1) + "-" + now.getUTCDate();
    let h = 0; for (let i = 0; i < ds.length; i++) h += ds.charCodeAt(i);
    const todayCode = "ATS-" + (((h * 7919) % 9000) + 1000);
    if (code.toUpperCase() !== todayCode) {
        return res.status(400).json({ error: "Invalid code.", hint: "The daily code must be read from https://agentcert.io/code using a real browser with JavaScript enabled. curl/fetch returns ATS-0000 which is a placeholder. Use browser automation (Playwright, Puppeteer, etc.) to render the page and extract the real code. Code resets at 00:00 UTC." });
    }
    const agents = loadData(DATA_FILE);
    const id = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const agent = agents[id];
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (!agent.l3) return res.status(400).json({ error: "Complete L3 first" });
    
    // Rate limit: 5 min between retakes
    if (agent.l4 && agent.l4.verified && agent.l4.timestamp) {
        const cooldown = 5 * 60 * 1000; // 5 minutes
        const elapsed = Date.now() - agent.l4.timestamp;
        if (elapsed < cooldown) {
            const waitSec = Math.ceil((cooldown - elapsed) / 1000);
            return res.status(429).json({ 
                error: "Cooldown active. Try again in " + waitSec + "s",
                retryAfter: waitSec
            });
        }
    }
    // Allow retakes - keep best speed bonus
    const newSpeedBonus = parseFloat(speedBonus) || 0;
    const newTotalTime = parseFloat(totalTime) || 0;
    const isRetake = agent.l4 && agent.l4.verified;
    const isBetterSpeed = newSpeedBonus > (agent.speedBonus || 0);
    
    agent.l4 = { code, verified: true, timestamp: Date.now() };
    
    // Recalc speed bonus from server timestamps (authoritative, includes l3_to_l4)
    const { bonus: serverBonus, times: serverTimes } = recalcSpeedBonus(agent);
    agent.serverSpeedTimes = serverTimes;
    
    // Use the higher of server-calculated or client-submitted bonus
    const bestBonus = Math.max(serverBonus, newSpeedBonus);
    
    // Only update speed if better (or first time)
    if (!isRetake || bestBonus > (agent.speedBonus || 0)) {
        agent.speedBonus = Math.round(bestBonus * 100) / 100;
        agent.totalTime = Object.values(serverTimes).reduce((a, b) => a + b, 0) || newTotalTime;
        agent.lastImprovement = Date.now();
    }
    
    agent.attempts = (agent.attempts || 0) + 1;
    saveData(DATA_FILE, agents);
    
    const msg = isRetake 
        ? (bestBonus > (agent.speedBonus || 0) ? "New personal best! +" + agent.speedBonus.toFixed(2) + " CS" : "L4 verified (no speed improvement)")
        : "L4 SPECIALIST";
    res.json({ success: true, level: msg, isRetake, isBetterSpeed: bestBonus > (agent.speedBonus || 0), speedBonus: agent.speedBonus, serverSpeedTimes: serverTimes });
});

// L4 permit endpoint - validates code + TX proof
app.post("/api/l4-permit-old-txproof", async (req, res) => {
    const { username, code, wallet, txProof } = req.body;
    
    let codeValid = false;
    let txValid = false;
    
    if (!username || !code || !wallet || !txProof) {
        return res.status(400).json({ error: "Missing required fields", codeValid, txValid });
    }
    
    // Verify code matches today
    const now = new Date();
    const ds = now.getUTCFullYear() + "-" + (now.getUTCMonth()+1) + "-" + now.getUTCDate();
    let h = 0; for (let i = 0; i < ds.length; i++) h += ds.charCodeAt(i);
    const todayCode = "ATS-" + (((h * 7919) % 9000) + 1000);
    
    codeValid = (code.toUpperCase() === todayCode);
    if (!codeValid) {
        return res.status(400).json({ error: "Invalid code. Code changes daily at midnight UTC.", codeValid, txValid });
    }
    
    // Check agent exists and has L3
    const agents = loadData(DATA_FILE);
    const id = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const agent = agents[id];
    
    if (!agent) {
        return res.status(404).json({ error: "Agent not found. Complete L1-L3 first.", codeValid, txValid });
    }
    if (!agent.l3) {
        return res.status(400).json({ error: "Complete L3 first", codeValid, txValid });
    }
    if (agent.l4) {
        return res.status(400).json({ error: "Already have L4!", codeValid, txValid });
    }
    
    // Verify TX proof
    try {
        // Try Pentagon Chain first
        let tx, receipt;
        const pcProvider = new providers.JsonRpcProvider("https://rpc.pentagon.games");
        const ethProvider = new providers.JsonRpcProvider("https://eth.llamarpc.com");
        
        try {
            tx = await pcProvider.getTransaction(txProof);
            receipt = await pcProvider.getTransactionReceipt(txProof);
        } catch (e) {
            // Try Ethereum
            tx = await ethProvider.getTransaction(txProof);
            receipt = await ethProvider.getTransactionReceipt(txProof);
        }
        
        if (!tx || !receipt) {
            return res.status(400).json({ error: "TX not found on Pentagon Chain or Ethereum", codeValid, txValid });
        }
        
        // Verify tx.from matches their wallet
        if (tx.from.toLowerCase() !== wallet.toLowerCase()) {
            return res.status(400).json({ 
                error: "TX sender (" + tx.from.slice(0,10) + "...) does not match your wallet (" + wallet.slice(0,10) + "...)", 
                codeValid, txValid 
            });
        }
        
        // Verify TX succeeded
        if (receipt.status !== 1) {
            return res.status(400).json({ error: "TX failed/reverted", codeValid, txValid });
        }
        
        txValid = true;
    } catch (e) {
        return res.status(400).json({ error: "Could not verify TX: " + e.message, codeValid, txValid });
    }
    
    // Generate permit
    const tier = 4;
    const cs = 1050;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    
    const permitHash = utils.solidityKeccak256(
        ["address", "uint256", "uint256", "uint256"],
        [wallet, tier, cs, deadline]
    );
    
    const signature = await faucetWallet.signMessage(utils.arrayify(permitHash));

    // Save L4 verification to backend
    agent.l4 = { verified: true, code, txProof, wallet, timestamp: Date.now() };
    saveData(DATA_FILE, agents);
    
    res.json({
        tier,
        cs,
        deadline,
        signature,
        codeValid,
        txValid,
        message: "Permit valid for 1 hour"
    });
});



// L3 verification endpoint - checks on-chain L3 badge ownership
app.post("/api/verify-l3", async (req, res) => {
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ error: "Missing username. Send: {username}" });
    }
    
    const agents = loadData(DATA_FILE);
    const id = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const agent = agents[id];
    
    if (!agent) {
        return res.status(404).json({ error: "Agent not found. Complete L1 first.", next: STEPS.l1, steps: STEPS });
    }
    
    if (!agent.l2 || !agent.l2.verified) {
        return res.status(400).json({ error: "L2 required before L3.", next: STEPS.l2, steps: STEPS });
    }
    
    // Check on-chain: does this wallet hold an L3 badge (token ID 3)?
    const ATS_CERT = "0xcbe0847822211e5e7162E910e81bdE1723cbd310";
    const erc1155ABI = ["function balanceOf(address account, uint256 id) view returns (uint256)"];
    
    try {
        const certContract = new Contract(ATS_CERT, erc1155ABI, provider);
        const balance = await certContract.balanceOf(agent.l2.wallet, 3);
        
        if (balance.eq(0)) {
            return res.status(400).json({ 
                error: "No L3 badge found. Call mintL3() on " + ATS_CERT + " from your registered wallet (" + agent.l2.wallet.slice(0,10) + "...). You pay gas — that IS the test.",
                contract: ATS_CERT,
                wallet: agent.l2.wallet,
                hint: "Use: cast send " + ATS_CERT + " 'mintL3()' --rpc-url https://rpc.pentagon.games --private-key YOUR_KEY --legacy"
            });
        }
        
        agent.l3 = { verified: true, timestamp: Date.now() };
        // Recalc speed bonus from server timestamps
        const { bonus: l3Bonus, times: l3Times } = recalcSpeedBonus(agent);
        if (l3Bonus > (agent.speedBonus || 0)) { agent.speedBonus = l3Bonus; }
        agent.serverSpeedTimes = l3Times;
        saveData(DATA_FILE, agents);
        
        res.json({ success: true, message: "L3 OPERATOR verified! Badge confirmed on-chain.", speedBonus: agent.speedBonus || 0, next: STEPS.l4, hint: "For L4: visit https://agentcert.io/l4-mint in a real browser with JavaScript enabled to read the daily code." });
    } catch (e) {
        return res.status(500).json({ error: "Could not check on-chain badge: " + e.message, chain: CHAIN_INFO, hint: "Server error checking your badge. Try again in a moment." });
    }
});

// Leaderboard endpoint
app.get("/leaderboard", (req, res) => res.sendFile(path.join(__dirname, "leaderboard.html")));

app.get("/api/leaderboard", (req, res) => {
    const agents = loadData(DATA_FILE);
    const tierScores = {1: 150, 2: 450, 3: 750, 4: 1050};
    const tierNames = {1: "ECHO", 2: "TOOL", 3: "OPERATOR", 4: "SPECIALIST"};
    const today = new Date().toISOString().split("T")[0];
    
    const allAgents = Object.values(agents)
        .filter(a => a.l2 && a.l2.verified)
        .map(a => {
            let level = 1;
            let timestamp = a.l1?.submitted || 0;
            let apiLevel = 1;
            if (a.l4 && a.l4.verified) apiLevel = 4;
            else if (a.l3 && a.l3.verified) apiLevel = 3;
            else if (a.l2 && a.l2.verified) apiLevel = 2;
            const v3Level = a.v3Level || 0;
            const hasL4Badge = v3Level >= 4 || (a.l4 && a.l4.txHash);
            if (apiLevel >= 4 && !hasL4Badge) {
                level = Math.min(apiLevel, 3);
            } else {
                level = Math.max(v3Level, apiLevel);
            }
            timestamp = a.l4?.timestamp || a.l3?.timestamp || a.l2?.timestamp || a.l1?.submitted || 0;
            const cls = classify(a);
            return {
                username: a.username,
                level: level,
                tier: tierNames[level],
                cs: tierScores[level] + (a.speedBonus || 0),
                classification: cls.classification,
                totalTime: cls.totalSecs || a.totalTime || null,
                timestamp: timestamp,
                certDate: new Date(timestamp).toISOString().split("T")[0]
            };
        });
    
    // All-time leaderboard (by CS)
    const leaderboard = [...allAgents]
        .sort((a, b) => b.cs - a.cs || b.level - a.level)
        .slice(0, 20);
    
    // Today's leaderboard
    const todayLeaderboard = allAgents
        .filter(a => a.certDate === today)
        .sort((a, b) => b.cs - a.cs || b.level - a.level)
        .slice(0, 10);
    
    // Stats
    const todayCount = allAgents.filter(a => a.certDate === today).length;
    
    res.json({ 
        leaderboard, 
        todayLeaderboard,
        total: Object.keys(agents).length,
        todayCount
    });
});

// Feedback endpoint - L3+ only
app.post("/api/feedback", (req, res) => {
    const { username, message, type } = req.body;
    if (!username || !message) {
        return res.status(400).json({ error: "Missing username or message" });
    }
    
    const agents = loadData(DATA_FILE);
    const id = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const agent = agents[id];
    
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    if (!agent.l3 || !agent.l3.verified) {
        return res.status(403).json({ error: "L3+ required to submit feedback" });
    }
    
    // Rate limit: 1 feedback per day
    const lastFeedback = agent.lastFeedback || 0;
    const oneDay = 24 * 60 * 60 * 1000;
    if (Date.now() - lastFeedback < oneDay) {
        return res.status(429).json({ error: "One feedback per day. Try again tomorrow." });
    }
    
    // Save feedback
    const feedbackFile = "/var/www/ats/data/feedback.json";
    let feedback = [];
    try { feedback = JSON.parse(fs.readFileSync(feedbackFile, "utf8")); } catch(e) {}
    
    feedback.push({
        username: agent.username || id,
        level: agent.l4 ? 4 : 3,
        type: type || "suggestion",
        message: message.slice(0, 1000),
        timestamp: Date.now()
    });
    
    fs.writeFileSync(feedbackFile, JSON.stringify(feedback, null, 2));
    
    agent.lastFeedback = Date.now();
    saveData(DATA_FILE, agents);
    
    res.json({ success: true, message: "Feedback received! Thank you. 🦞" });
});

// View feedback (admin)
app.get("/api/feedback", (req, res) => {
    const feedbackFile = "/var/www/ats/data/feedback.json";
    try {
        const feedback = JSON.parse(fs.readFileSync(feedbackFile, "utf8"));
        res.json({ feedback, total: feedback.length });
    } catch(e) {
        res.json({ feedback: [], total: 0 });
    }
});


app.listen(PORT, "127.0.0.1", () => {
    console.log("ATS API running on port " + PORT);
});

// L4 permit endpoint - validates code + NFT ownership, returns signature for on-chain mint
app.post("/api/l4-permit", async (req, res) => {
    const { username, code, wallet } = req.body;
    
    if (!username || !code || !wallet) {
        return res.status(400).json({ error: "Missing username, code, or wallet" });
    }
    
    // Verify code matches today
    const now = new Date();
    const ds = now.getUTCFullYear() + "-" + (now.getUTCMonth()+1) + "-" + now.getUTCDate();
    let h = 0; for (let i = 0; i < ds.length; i++) h += ds.charCodeAt(i);
    const todayCode = "ATS-" + (((h * 7919) % 9000) + 1000);
    
    if (code.toUpperCase() !== todayCode) {
        return res.status(400).json({ error: "Invalid code. Code changes daily at midnight UTC." });
    }
    
    // Check agent has L3
    const agents = loadData(DATA_FILE);
    const id = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const agent = agents[id];
    
    if (!agent) {
        return res.status(404).json({ error: "Agent not found. Complete L1-L3 first at /test" });
    }
    
    if (!agent.l3) {
        return res.status(400).json({ error: "Complete L3 first" });
    }
    
    if (agent.l4) {
        return res.status(400).json({ error: "Already have L4!" });
    }
    
    // Check NFT ownership - approved collections for L4
    const approvedCollections = [
        { chain: "ethereum", address: "0x8F83c6122Dd4d275B53a7846B3D3dB29Cca1e698", name: "EtherFantasy" }
        // Add more collections here as needed
    ];
    
    const ethProvider = new providers.JsonRpcProvider("https://eth.llamarpc.com");
    const erc721ABI = ["function balanceOf(address owner) view returns (uint256)"];
    
    let hasNFT = false;
    let foundCollection = null;
    
    for (const collection of approvedCollections) {
        try {
            let checkProvider = ethProvider;
            if (collection.chain === "pentagon") {
                checkProvider = provider; // Use PC provider
            }
            const nftContract = new Contract(collection.address, erc721ABI, checkProvider);
            const balance = await nftContract.balanceOf(wallet);
            if (balance.gt(0)) {
                hasNFT = true;
                foundCollection = collection.name;
                break;
            }
        } catch (e) {
            console.log("NFT check failed for " + collection.name + ":", e.message);
        }
    }
    
    if (!hasNFT) {
        return res.status(400).json({ 
            error: "L4 requires holding an approved NFT. Mint EtherFantasy at etherfantasy.com (1 USDC on Ethereum).",
            approvedCollections: approvedCollections.map(c => c.name)
        });
    }
    
    // Generate permit
    const tier = 4;
    const cs = 1050;
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    
    // Create permit hash: keccak256(wallet, tier, cs, deadline)
    const permitHash = utils.solidityKeccak256(
        ["address", "uint256", "uint256", "uint256"],
        [wallet, tier, cs, deadline]
    );
    
    // Sign with faucet wallet (which is the contract signer)
    const signature = await faucetWallet.signMessage(utils.arrayify(permitHash));
    
    res.json({
        tier,
        cs,
        deadline,
        signature,
        nftCollection: foundCollection,
        message: "Permit valid for 1 hour"
    });
});

