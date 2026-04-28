import express from 'express';
import fs from 'fs';
import chalk from 'chalk';
import multer from 'multer';
import makeWASocket, { 
    useMultiFileAuthState, 
    makeCacheableSignalKeyStore, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { Boom } from '@hapi/boom';
import cors from 'cors';
import qrcode from 'qrcode-terminal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 5000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Store all sessions
const sessions = {};
const stopFlags = {};
const activeSockets = {};
const messageQueues = {};
const reconnectAttempts = {};
const connectionStates = {};

const SessionState = {
    INIT: 'INIT',
    CONNECTED: 'CONNECTED',
    RECONNECTING: 'RECONNECTING',
    STOPPED: 'STOPPED'
};

// Heartbeat monitoring
setInterval(() => {
    console.log(chalk.yellow('═'.repeat(50)));
    console.log(chalk.yellow('🟡 SYSTEM STATUS CHECK 🟡'));
    console.log(chalk.yellow(`📊 Active Sessions: ${Object.keys(activeSockets).length}`));
    console.log(chalk.yellow(`📊 Total Sessions: ${Object.keys(sessions).length}`));
    for (const [key, session] of Object.entries(sessions)) {
        const state = connectionStates[key] || 'UNKNOWN';
        const icon = state === SessionState.CONNECTED ? '🟢' : state === SessionState.RECONNECTING ? '🟡' : '🔴';
        console.log(chalk.yellow(`${icon} ${session.phoneNumber || key}: ${state}`));
    }
    console.log(chalk.yellow('═'.repeat(50)));
}, 30000);

const saveSessions = () => {
    try {
        const sessionsToSave = {};
        for (const key in sessions) {
            const { ...sessionData } = sessions[key];
            sessionsToSave[key] = sessionData;
        }
        fs.writeFileSync('./sessions.json', JSON.stringify(sessionsToSave, null, 2), 'utf8');
        console.log(chalk.green('💾 Sessions saved successfully'));
    } catch (error) {
        console.error(chalk.red(`Error saving sessions: ${error.message}`));
    }
};

const generateUniqueKey = () => {
    return crypto.randomBytes(16).toString('hex');
};

const startMessaging = (socket, uniqueKey, target, hatersName, messages, speed) => {
    if (stopFlags[uniqueKey]?.timeout) {
        clearTimeout(stopFlags[uniqueKey].timeout);
    }

    if (!messageQueues[uniqueKey]) {
        messageQueues[uniqueKey] = {
            messages: [...messages],
            currentIndex: 0,
            isSending: false
        };
    }

    const queue = messageQueues[uniqueKey];
    
    const sendNextMessage = async () => {
        if (stopFlags[uniqueKey]?.stopped || connectionStates[uniqueKey] === SessionState.STOPPED) {
            if (stopFlags[uniqueKey]?.timeout) clearTimeout(stopFlags[uniqueKey].timeout);
            delete messageQueues[uniqueKey];
            return;
        }

        if (!activeSockets[uniqueKey] || connectionStates[uniqueKey] !== SessionState.CONNECTED) {
            console.log(chalk.yellow(`⏳ Waiting for connection...`));
            return;
        }

        if (queue.isSending) return;

        queue.isSending = true;
        const chatId = target.includes('@g.us') ? target : `${target}@s.whatsapp.net`;
        const currentMessage = queue.messages[queue.currentIndex];
        const formattedMessage = `${hatersName} ${currentMessage}`;

        try {
            await socket.sendMessage(chatId, { text: formattedMessage });
            console.log(chalk.green(`✉️ [${uniqueKey.substring(0,8)}] Message ${queue.currentIndex + 1}/${queue.messages.length}: ${formattedMessage.substring(0, 50)}...`));
            
            queue.currentIndex++;
            if (queue.currentIndex >= queue.messages.length) {
                console.log(chalk.cyan(`🔄 [${uniqueKey.substring(0,8)}] All messages sent! Looping...`));
                queue.currentIndex = 0;
            }
        } catch (err) {
            console.error(chalk.red(`❌ [${uniqueKey.substring(0,8)}] Send error: ${err.message}`));
        } finally {
            queue.isSending = false;
        }
    };

    const baseInterval = (parseInt(speed) || 5) * 1000;
    const intervalFunc = async () => {
        await sendNextMessage();
        if (!stopFlags[uniqueKey]?.stopped && connectionStates[uniqueKey] === SessionState.CONNECTED) {
            stopFlags[uniqueKey].timeout = setTimeout(intervalFunc, baseInterval);
        }
    };

    stopFlags[uniqueKey] = { stopped: false, timeout: setTimeout(intervalFunc, baseInterval) };
    console.log(chalk.cyan(`📨 [${uniqueKey.substring(0,8)}] Message automation started (interval: ${baseInterval/1000}s)`));
};

const connectAndLogin = async (phoneNumber, uniqueKey, sendResponse = null) => {
    const sessionPath = `./sessions_data/${uniqueKey}`;
    
    // Ensure session directory exists
    if (!fs.existsSync('./sessions_data')) {
        fs.mkdirSync('./sessions_data', { recursive: true });
    }
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    if (!connectionStates[uniqueKey]) connectionStates[uniqueKey] = SessionState.INIT;

    const startConnection = async (retryCount = 0) => {
        if (connectionStates[uniqueKey] === SessionState.CONNECTED && activeSockets[uniqueKey]) {
            console.log(chalk.green(`✅ [${uniqueKey.substring(0,8)}] Already connected`));
            return activeSockets[uniqueKey];
        }

        try {
            console.log(chalk.magenta(`🚀 [${connectionStates[uniqueKey]}] Starting connection for ${phoneNumber || uniqueKey.substring(0,8)}`));

            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            if (activeSockets[uniqueKey]) {
                try {
                    activeSockets[uniqueKey].ev.removeAllListeners();
                    await activeSockets[uniqueKey].end();
                    delete activeSockets[uniqueKey];
                } catch (e) {}
            }

            const socket = makeWASocket({
                version,
                logger: pino({ level: 'fatal' }),
                browser: Browsers.macOS('Desktop'),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
                },
                printQRInTerminal: false,
                markOnlineOnConnect: true,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
                defaultQueryTimeoutMs: 60000,
                generateHighQualityLinkPreview: false,
                patchMessageBeforeSending: (message) => message,
            });

            activeSockets[uniqueKey] = socket;

            // Handle QR Code if needed
            if (!socket.authState.creds.registered) {
                socket.ev.on('connection.update', (update) => {
                    const { qr } = update;
                    if (qr && sendResponse) {
                        console.log(chalk.yellow(`📱 QR Code for ${phoneNumber}:`));
                        qrcode.generate(qr, { small: true });
                        sendResponse({ success: false, message: 'QR Code for pairing', qr, uniqueKey });
                    }
                });
            }

            // Request pairing code for phone number
            if (phoneNumber && !socket.authState.creds.registered) {
                setTimeout(async () => {
                    try {
                        const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');
                        if (cleanedNumber.length >= 10) {
                            const code = await socket.requestPairingCode(cleanedNumber);
                            const pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                            console.log(chalk.green(`🔑 Pairing code for ${cleanedNumber}: ${pairingCode}`));
                            if (sendResponse) {
                                sendResponse({ success: true, message: 'Pairing code generated', pairingCode, uniqueKey });
                            }
                        }
                    } catch (error) {
                        console.error(chalk.red(`❌ Pairing error: ${error.message}`));
                    }
                }, 3000);
            }

            socket.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (connection === "open") {
                    console.log(chalk.green(`\n✅ WhatsApp Connected! ${phoneNumber || uniqueKey.substring(0,8)} ✅\n`));
                    connectionStates[uniqueKey] = SessionState.CONNECTED;
                    reconnectAttempts[uniqueKey] = 0;
                    
                    sessions[uniqueKey] = { 
                        ...sessions[uniqueKey],
                        phoneNumber: phoneNumber || 'unknown',
                        uniqueKey,
                        connected: true,
                        lastUpdate: Date.now() 
                    };
                    saveSessions();

                    // Restart messaging if it was running
                    if (sessions[uniqueKey]?.messaging && sessions[uniqueKey]?.messages) {
                        startMessaging(socket, uniqueKey, sessions[uniqueKey].target, sessions[uniqueKey].hatersName, sessions[uniqueKey].messages, sessions[uniqueKey].speed);
                    }
                }

                if (connection === "close") {
                    const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 500;
                    let shouldReconnect = true;
                    
                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log(chalk.bold.red(`🚨 Logged out for ${uniqueKey.substring(0,8)}`));
                        shouldReconnect = false;
                        connectionStates[uniqueKey] = SessionState.STOPPED;
                        if (sendResponse) {
                            sendResponse({ success: false, message: 'Session logged out', uniqueKey });
                        }
                    } else if (statusCode === 401) {
                        console.log(chalk.bold.red(`🚨 Authentication error (401) for ${uniqueKey.substring(0,8)}`));
                        shouldReconnect = false;
                    } else {
                        console.log(chalk.yellow(`⚠️ Connection closed with code ${statusCode}. Reconnecting...`));
                    }
                    
                    if (shouldReconnect && connectionStates[uniqueKey] !== SessionState.STOPPED) {
                        connectionStates[uniqueKey] = SessionState.RECONNECTING;
                        delete activeSockets[uniqueKey];
                        if (stopFlags[uniqueKey]?.timeout) clearTimeout(stopFlags[uniqueKey].timeout);
                        
                        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts[uniqueKey] || 0), 60000);
                        reconnectAttempts[uniqueKey] = (reconnectAttempts[uniqueKey] || 0) + 1;
                        console.log(chalk.cyan(`🔄 Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts[uniqueKey]})`));
                        setTimeout(() => startConnection(reconnectAttempts[uniqueKey]), delay);
                    } else if (!shouldReconnect) {
                        console.log(chalk.red(`❌ Not reconnecting for ${uniqueKey.substring(0,8)}`));
                    }
                }
            });

            socket.ev.on('creds.update', () => {
                saveCreds();
                console.log(chalk.blue(`🔐 Credentials updated for ${uniqueKey.substring(0,8)}`));
            });

            socket.ev.on('messages.upsert', async ({ messages }) => {
                const msg = messages[0];
                if (!msg.key.fromMe && msg.message) {
                    console.log(chalk.blue(`💬 Received message from ${msg.key.remoteJid}`));
                }
            });

            return socket;

        } catch (error) {
            console.error(chalk.red(`❌ Connection Error: ${error.message}`));
            if (connectionStates[uniqueKey] !== SessionState.STOPPED && retryCount < 5) {
                const delay = 10000 * (retryCount + 1);
                console.log(chalk.yellow(`🔄 Retry ${retryCount + 1}/5 in ${delay/1000}s`));
                setTimeout(() => startConnection(retryCount + 1), delay);
            }
            return null;
        }
    };

    return await startConnection();
};

const restoreSessions = async () => {
    if (fs.existsSync('./sessions.json')) {
        try {
            const data = fs.readFileSync('./sessions.json', 'utf8');
            const savedSessions = JSON.parse(data);
            Object.assign(sessions, savedSessions);
            console.log(chalk.cyan(`🔄 Restoring ${Object.keys(savedSessions).length} sessions...`));
            
            for (const [key, session] of Object.entries(sessions)) {
                if (session.phoneNumber && session.uniqueKey) {
                    console.log(chalk.cyan(`🔄 Restoring: ${session.phoneNumber}`));
                    await connectAndLogin(session.phoneNumber, session.uniqueKey, null);
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Delay between restores
                }
            }
        } catch (err) {
            console.error(chalk.red(`Error restoring sessions: ${err.message}`));
        }
    }
};

// API Routes
app.post('/login', async (req, res) => {
    try {
        let { phoneNumber } = req.body;
        if (!phoneNumber) {
            return res.status(400).json({ success: false, message: 'Phone number is required!' });
        }
        
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
        const uniqueKey = generateUniqueKey();
        
        let responseSent = false;
        const sendResponse = (data) => {
            if (!responseSent) {
                responseSent = true;
                res.json(data);
            }
        };
        
        // Set timeout
        const timeout = setTimeout(() => {
            if (!responseSent) {
                sendResponse({ success: false, message: 'Connection timeout', uniqueKey });
            }
        }, 60000);
        
        await connectAndLogin(phoneNumber, uniqueKey, sendResponse);
        clearTimeout(timeout);
        
    } catch (error) {
        res.status(500).json({ success: false, message: `Server Error: ${error.message}` });
    }
});

app.post('/logout', async (req, res) => {
    const { uniqueKey } = req.body;
    if (!uniqueKey || !sessions[uniqueKey]) {
        return res.status(400).json({ success: false, message: 'Invalid session' });
    }
    
    connectionStates[uniqueKey] = SessionState.STOPPED;
    if (stopFlags[uniqueKey]?.timeout) clearTimeout(stopFlags[uniqueKey].timeout);
    
    if (activeSockets[uniqueKey]) {
        try {
            await activeSockets[uniqueKey].logout();
            delete activeSockets[uniqueKey];
        } catch (e) {
            delete activeSockets[uniqueKey];
        }
    }
    
    const sessionPath = `./sessions_data/${uniqueKey}`;
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    
    delete sessions[uniqueKey];
    saveSessions();
    
    res.json({ success: true, message: 'Logged out successfully' });
});

app.post('/getGroups', async (req, res) => {
    try {
        const { uniqueKey } = req.body;
        if (!uniqueKey || !activeSockets[uniqueKey]) {
            return res.status(400).json({ success: false, message: 'Invalid session or not connected' });
        }
        
        const groups = await activeSockets[uniqueKey].groupFetchAllParticipating();
        const groupList = Object.values(groups).map(group => ({
            name: group.subject,
            id: group.id,
            participants: group.participants?.length || 0
        }));
        
        res.json({ success: true, groups: groupList });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/getContacts', async (req, res) => {
    try {
        const { uniqueKey } = req.body;
        if (!uniqueKey || !activeSockets[uniqueKey]) {
            return res.status(400).json({ success: false, message: 'Invalid session or not connected' });
        }
        
        const contacts = await activeSockets[uniqueKey].contacts;
        const contactList = Object.values(contacts).map(contact => ({
            name: contact.name || contact.verifiedName || contact.id,
            id: contact.id
        }));
        
        res.json({ success: true, contacts: contactList });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/startMessaging', upload.single('messageFile'), async (req, res) => {
    try {
        const { uniqueKey, target, hatersName, speed } = req.body;
        const filePath = req.file?.path;
        
        if (!uniqueKey || !target || !activeSockets[uniqueKey] || !filePath) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const messages = fileContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        fs.unlinkSync(filePath);
        
        if (messages.length === 0) {
            return res.status(400).json({ success: false, message: 'No messages found in file' });
        }
        
        sessions[uniqueKey] = {
            ...sessions[uniqueKey],
            target,
            hatersName: hatersName || '',
            messages,
            speed: speed || 5,
            messaging: true
        };
        saveSessions();
        
        startMessaging(activeSockets[uniqueKey], uniqueKey, target, hatersName || '', messages, speed);
        res.json({ success: true, message: 'Messaging started', totalMessages: messages.length, interval: `${speed}s` });
        
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/stopMessaging', async (req, res) => {
    const { uniqueKey } = req.body;
    
    if (!uniqueKey || !sessions[uniqueKey]) {
        return res.status(400).json({ success: false, message: 'Invalid session' });
    }
    
    if (stopFlags[uniqueKey]) {
        stopFlags[uniqueKey].stopped = true;
        if (stopFlags[uniqueKey].timeout) {
            clearTimeout(stopFlags[uniqueKey].timeout);
        }
    }
    
    sessions[uniqueKey].messaging = false;
    saveSessions();
    
    res.json({ success: true, message: 'Messaging stopped' });
});

app.get('/status', async (req, res) => {
    const status = {};
    for (const [key, session] of Object.entries(sessions)) {
        status[key] = {
            phoneNumber: session.phoneNumber,
            connected: connectionStates[key] === SessionState.CONNECTED,
            state: connectionStates[key] || 'UNKNOWN',
            messaging: session.messaging || false,
            target: session.target || null,
            messagesCount: session.messages?.length || 0
        };
    }
    res.json({ success: true, sessions: status, activeCount: Object.keys(activeSockets).length });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handlers
process.on('uncaughtException', (error) => {
    console.error(chalk.red('🔥 Uncaught Exception:'), error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(chalk.red('⚠️ Unhandled Rejection:'), reason);
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(chalk.green('\n' + '═'.repeat(60)));
    console.log(chalk.green('✅ WhatsApp Bot Server Running'));
    console.log(chalk.green(`📡 Port: ${PORT}`));
    console.log(chalk.green(`🌐 URL: http://localhost:${PORT}`));
    console.log(chalk.green('═'.repeat(60) + '\n'));
    
    console.log(chalk.yellow('🔄 Restoring previous sessions...'));
    await restoreSessions();
    
    console.log(chalk.green('\n✅ System ready! Bot will run continuously'));
    console.log(chalk.cyan('💡 Use PM2 for production: npm run pm2:start\n'));
});
