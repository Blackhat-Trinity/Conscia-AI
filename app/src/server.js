'use strict';

/**
 * WebRTC Video Call App - Server
 *
 * A private peer-to-peer video calling application built on WebRTC.
 * Forked and customised from MiroTalk P2P.
 */

const { auth, requiresAuth } = require('express-openid-connect');
const { Server } = require('socket.io');
const httpolyglot = require('httpolyglot');
const http = require('http');
const compression = require('compression');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const app = express();
const fs = require('fs');
const checkXSS = require('./xss.js');
const ServerApi = require('./api');
const MattermostController = require('./mattermost');
const Validate = require('./validate');
const HtmlInjector = require('./htmlInjector');
const Host = require('./host');
const Logs = require('./logs');
const log = new Logs('server');

// Central configuration (reads .env via dotenv internally)
const config = require('./config');

// Email alerts and notifications
const nodemailer = require('./lib/nodemailer');

const packageJson = require('../../package.json');

// Login attempts limit
const rateLimit = require('express-rate-limit');
const maxAttempts = config.host.maxLoginAttempts;
const minBlockTime = config.host.minLoginBlockTime; // in minutes
const loginLimiter = rateLimit({
    windowMs: minBlockTime * 60 * 1000,
    max: maxAttempts,
    message: {
        message: `Too many login attempts. Please try again after ${minBlockTime} minute${minBlockTime == 1 ? '' : 's'}.`,
    },
    keyGenerator: (req) => req.body?.username || getIP(req),
});

const port = config.server.port;
const host = config.server.host;

const authHost = new Host(); // Authenticated IP by Login

// -------------------------------------------------------
// SSL / HTTPS setup — gracefully falls back to plain HTTP
// -------------------------------------------------------
const keyPath = path.join(__dirname, '../ssl/key.pem');
const certPath = path.join(__dirname, '../ssl/cert.pem');

let server;

try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        const options = {
            key: fs.readFileSync(keyPath, 'utf-8'),
            cert: fs.readFileSync(certPath, 'utf-8'),
        };
        server = httpolyglot.createServer(options, app);
        log.info('Server mode: HTTP + HTTPS (httpolyglot)');
    } else {
        log.warn('SSL certificates not found — starting in HTTP-only mode.');
        server = http.createServer(app);
    }
} catch (err) {
    log.warn('Failed to load SSL certificates — starting in HTTP-only mode.', err.message);
    server = http.createServer(app);
}

// Handle client errors (malformed/incomplete HTTP requests) gracefully
server.on('clientError', (err, socket) => {
    err.code === 'HPE_HEADER_OVERFLOW' || err.message === 'Parse Error'
        ? log.warn('Client HTTP parse error', { error: err.message, code: err.code })
        : log.warn('Client connection error', { error: err.message, code: err.code });
    if (socket && !socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

// Trust Proxy
const trustProxy = config.server.trustProxy;

// Cors
const corsOptions = {
    origin: config.cors.origin,
    methods: config.cors.methods,
};

/*
    Set maxHttpBufferSize from 1e6 (1MB) to 1e7 (10MB)
*/
const io = new Server({
    maxHttpBufferSize: 1e7,
    transports: ['websocket'],
    cors: corsOptions,
}).listen(server);

// Host protection (disabled by default)
const hostCfg = {
    protected: config.host.protected,
    user_auth: config.host.userAuth,
    users: config.host.users,
    authenticated: !config.host.protected,
    maxRoomParticipants: config.host.maxRoomParticipants,
    showActiveRooms: config.host.showActiveRooms,
};

// JWT config
const jwtCfg = {
    JWT_KEY: config.jwt.key,
    JWT_EXP: config.jwt.exp,
};

// Room presenters
const roomPresenters = config.presenters;

// Swagger config
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = yaml.load(fs.readFileSync(path.join(__dirname, '/../api/swagger.yaml'), 'utf8'));

// Api config
const { v4: uuidV4 } = require('uuid');
const apiBasePath = '/api/v1';
const api_docs = host + apiBasePath + '/docs';
const api_key_secret = config.api.keySecret;
const api_disabled = config.api.disabled;

// Ngrok config
const ngrok = require('@ngrok/ngrok');
const ngrokEnabled = config.ngrok.enabled;
const ngrokAuthToken = config.ngrok.authToken;

// Handle WebHook
const webhook = {
    enabled: config.webhook?.enabled || false,
    url: config.webhook?.url || 'http://localhost:8888/webhook-endpoint',
};

// ICE Servers (STUN / TURN)
const iceServers = [];
const stunServerUrl = config.webrtc.stun.url;
const turnServerUrl = config.webrtc.turn.url;
const turnServerUsername = config.webrtc.turn.username;
const turnServerCredential = config.webrtc.turn.credential;
const stunServerEnabled = config.webrtc.stun.enabled;
const turnServerEnabled = config.webrtc.turn.enabled;
if (stunServerEnabled && stunServerUrl) iceServers.push({ urls: stunServerUrl });
if (turnServerEnabled && turnServerUrl && turnServerUsername && turnServerCredential) {
    iceServers.push({ urls: turnServerUrl, username: turnServerUsername, credential: turnServerCredential });
}

const testStunTurn = host + '/icetest';

// Feature flags
const IPLookupEnabled = config.ipLookup.enabled;
const surveyEnabled = config.survey.enabled;
const surveyURL = config.survey.url;
const redirectEnabled = config.redirect.enabled;
const redirectURL = config.redirect.url;

// Sentry config
const Sentry = require('@sentry/node');
const sentryEnabled = config.sentry.enabled;
const sentryDSN = config.sentry.dsn;
const sentryTracesSampleRate = config.sentry.tracesSampleRate;

// Slack API
const CryptoJS = require('crypto-js');
const qS = require('qs');
const slackEnabled = config.slack.enabled;
const slackSigningSecret = config.slack.signingSecret;

// Setup Sentry
if (sentryEnabled && typeof sentryDSN === 'string' && sentryDSN.trim()) {
    log.info('Sentry monitoring started...');
    Sentry.init({ dsn: sentryDSN, tracesSampleRate: sentryTracesSampleRate });

    const logLevels = config.sentry.logLevels;
    const stripAnsi = (str) => (typeof str === 'string' ? str.replace(/\u001b\[[0-9;]*m/g, '') : str);
    const originalConsole = {};
    logLevels.forEach((level) => {
        originalConsole[level] = console[level];
        console[level] = function (...args) {
            const cleanArgs = args.map(stripAnsi);
            if (level === 'warn') Sentry.captureMessage(cleanArgs.join(' '), 'warning');
            if (level === 'error') {
                args[0] instanceof Error
                    ? Sentry.captureException(args[0])
                    : Sentry.captureException(new Error(cleanArgs.join(' ')));
            }
            originalConsole[level].apply(console, args);
        };
    });
}

// OpenAI/ChatGPT
let chatGPT;
const configChatGPT = config.chatGPT;
if (configChatGPT.enabled) {
    if (configChatGPT.apiKey) {
        const { OpenAI } = require('openai');
        chatGPT = new OpenAI({ basePath: configChatGPT.basePath, apiKey: configChatGPT.apiKey });
    } else {
        log.warn('ChatGPT seems enabled, but apiKey is missing!');
    }
}

// IP Whitelist
const ipWhitelist = config.ipWhitelist;

// OIDC - Open ID Connect
const OIDC = config.oidc;

// Custom middleware function for OIDC authentication
function OIDCAuth(req, res, next) {
    if (OIDC.enabled) {
        function handleHostProtected(req) {
            if (!hostCfg.protected) return;
            const ip = authHost.getIP(req);
            hostCfg.authenticated = true;
            authHost.setAuthorizedIP(ip, true);
            log.debug('OIDC ------> Host protected', {
                authenticated: hostCfg.authenticated,
                authorizedIPs: authHost.getAuthorizedIPs(),
            });
        }

        if (req.oidc.isAuthenticated()) {
            log.debug('OIDC ------> User already Authenticated');
            handleHostProtected(req);
            return next();
        }

        requiresAuth()(req, res, function () {
            log.debug('OIDC ------> requiresAuth');
            if (req.oidc.isAuthenticated()) {
                log.debug('[OIDC] ------> User isAuthenticated');
                handleHostProtected(req);
                next();
            } else {
                res.status(401).send('Unauthorized');
            }
        });
    } else {
        next();
    }
}

// Mattermost config
const mattermostCfg = {
    enabled: config.mattermost.enabled,
    server_url: config.mattermost.serverUrl,
    username: config.mattermost.username,
    password: config.mattermost.password,
    token: config.mattermost.token,
    roomTokenExpire: config.mattermost.roomTokenExpire,
    encryptionKey: config.jwt.key,
    security: hostCfg.protected || OIDC.enabled,
    api_disabled: api_disabled,
};

// Stats configuration
const statsData = config.stats;

// Directory/view paths
const dir = { public: path.join(__dirname, '../../', 'public') };
const views = {
    about: path.join(__dirname, '../../', 'public/views/about.html'),
    client: path.join(__dirname, '../../', 'public/views/client.html'),
    landing: path.join(__dirname, '../../', 'public/views/landing.html'),
    login: path.join(__dirname, '../../', 'public/views/login.html'),
    newCall: path.join(__dirname, '../../', 'public/views/newcall.html'),
    notFound: path.join(__dirname, '../../', 'public/views/404.html'),
    privacy: path.join(__dirname, '../../', 'public/views/privacy.html'),
    activeRooms: path.join(__dirname, '../../', 'public/views/activeRooms.html'),
    customizeRoom: path.join(__dirname, '../../', 'public/views/customizeRoom.html'),
    stunTurn: path.join(__dirname, '../../', 'public/views/testStunTurn.html'),
    waitingRoom: path.join(__dirname, '../../', 'public/views/waitingRoom.html'),
};

// Branding configuration
const brandHtmlInjection = config.brand?.htmlInjection ?? true;

const filesPath = [
    views.landing,
    views.newCall,
    views.client,
    views.login,
    views.activeRooms,
    views.customizeRoom,
    views.waitingRoom,
];
const htmlInjector = new HtmlInjector(filesPath, config.brand || null);

const channels = {};
const sockets = {};
const peers = {};
const presenters = {};

const roomMetaKeys = new Set(['lock', 'password']);

function getPeerCount(roomId) {
    if (!peers[roomId]) return 0;
    return Object.keys(peers[roomId]).filter((k) => !roomMetaKeys.has(k)).length;
}

app.set('trust proxy', trustProxy);
app.use(helmet.noSniff());

const staticOptions = {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript');
    },
};

app.use(express.static(dir.public, staticOptions));
app.use('/mattermost', express.static(dir.public, staticOptions));
app.use(cors(corsOptions));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(apiBasePath + '/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// IP Whitelist middleware
app.use((req, res, next) => {
    if (!ipWhitelist.enabled) return next();
    const clientIP = getIP(req);
    log.debug('Check IP', clientIP);
    if (ipWhitelist.allowed.includes(clientIP)) {
        next();
    } else {
        log.info('Forbidden: Access denied from this IP address', { clientIP });
        res.status(403).json({ error: 'Forbidden', message: 'Access denied from this IP address.' });
    }
});

// Request logging middleware
app.use((req, res, next) => {
    log.debug('New request:', { ip: getIP(req), method: req.method, path: req.originalUrl, body: req.body });
    next();
});

// Mattermost integration
const mattermost = new MattermostController(app, mattermostCfg, htmlInjector, views.client);

// Error handler for malformed JSON / trailing slashes
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        log.error('Request Error', { header: req.headers, body: req.body, error: err.message });
        return res.status(400).send({ status: 400, message: 'Invalid JSON' });
    }
    if (req.path.substr(-1) === '/' && req.path.length > 1) {
        let query = req.url.slice(req.path.length);
        res.redirect(301, req.path.slice(0, -1) + query);
    } else {
        next();
    }
});

// OIDC middleware
if (OIDC.enabled) {
    if (OIDC.baseUrlDynamic) {
        const authMiddlewareCache = new Map();
        app.use((req, res, next) => {
            const hostHeader = req.headers.host;
            const protocol = req.protocol === 'https' ? 'https' : 'http';
            const cacheKey = `${protocol}://${hostHeader}`;
            if (!authMiddlewareCache.has(cacheKey)) {
                authMiddlewareCache.set(cacheKey, auth({ ...OIDC.config, baseURL: cacheKey }));
            }
            try {
                authMiddlewareCache.get(cacheKey)(req, res, next);
            } catch (err) {
                log.error('OIDC Auth Middleware Error', err);
                process.exit(1);
            }
        });
    } else {
        app.use(auth(OIDC.config));
    }
}

// Routes
app.get('/profile', OIDCAuth, (req, res) => {
    if (OIDC.enabled) {
        log.debug('OIDC User profile requested', req.oidc.user);
        return res.json(req.oidc.user);
    }
    return res.json({ profile: false });
});

app.get('/auth/callback', (req, res, next) => next());

app.get('/logout', (req, res) => {
    if (OIDC.enabled) {
        if (hostCfg.protected) {
            const ip = authHost.getIP(req);
            if (authHost.isAuthorizedIP(ip)) authHost.deleteIP(ip);
            hostCfg.authenticated = false;
            log.debug('[OIDC] ------> Logout', {
                authenticated: hostCfg.authenticated,
                authorizedIPs: authHost.getAuthorizedIPs(),
            });
        }
        req.logout();
    }
    res.redirect('/');
});

app.get('/', OIDCAuth, (req, res) => {
    if (!OIDC.enabled && hostCfg.protected) {
        hostCfg.authenticated = false;
        res.redirect('/login');
    } else {
        return htmlInjector.injectHtml(views.landing, res);
    }
});

app.get('/newcall', OIDCAuth, (req, res) => {
    if (!OIDC.enabled && hostCfg.protected) {
        hostCfg.authenticated = false;
        res.redirect('/login');
    } else {
        htmlInjector.injectHtml(views.newCall, res);
    }
});

app.get('/activeRooms', OIDCAuth, (req, res) => htmlInjector.injectHtml(views.activeRooms, res));
app.get('/customizeRoom', OIDCAuth, (req, res) => htmlInjector.injectHtml(views.customizeRoom, res));
app.get('/stats', (req, res) => res.send(statsData));
app.get(['/about'], (req, res) => res.sendFile(views.about));
app.get(['/privacy'], (req, res) => res.sendFile(views.privacy));
app.get(['/icetest'], (req, res) => {
    if (Object.keys(req.query).length > 0) log.debug('Request Query', req.query);
    res.sendFile(views.stunTurn);
});

app.post('/isRoomActive', (req, res) => {
    const { roomId } = checkXSS(req.body);
    if (roomId && (hostCfg.protected || hostCfg.user_auth || OIDC.enabled)) {
        const roomActive = Object.prototype.hasOwnProperty.call(peers, roomId);
        if (roomActive) log.debug('isRoomActive', { roomId, roomActive });
        res.status(200).json({ message: roomActive });
    } else {
        res.status(400).json({ message: 'Unauthorized' });
    }
});

app.post('/isWidgetRoomActive', (req, res) => {
    const { roomId } = checkXSS(req.body);
    const roomWidgetActive =
        roomId && roomId === config.brand?.widget?.roomId && Object.prototype.hasOwnProperty.call(peers, roomId);
    log.debug('isWidgetRoomActive', { roomId, roomWidgetActive });
    res.status(200).json({ message: roomWidgetActive });
});

app.get('/join/', async (req, res) => {
    if (Object.keys(req.query).length > 0) {
        log.debug('Request Query', req.query);
        const { room, name, audio, video, screen, chat, notify, hide, duration, token } = checkXSS(req.query);

        if (!room) {
            log.warn('/join/params room empty', room);
            return res.status(401).json({ message: 'Direct Room Join: Missing mandatory room parameter!' });
        }
        if (!Validate.isValidRoomName(room)) {
            return res.status(400).json({ message: 'Invalid Room name!\nPath traversal pattern detected!' });
        }

        const allowRoomAccess = isAllowedRoomAccess('/join/params', req, hostCfg, peers, room);
        if (!allowRoomAccess && !token) return res.status(401).json({ message: 'Direct Room Join Unauthorized' });

        let peerUsername, peerPassword = '';
        let isPeerValid = false;
        let isPeerPresenter = false;

        if (token) {
            try {
                const validToken = await isValidToken(token);
                if (!validToken) return res.status(401).json({ message: 'Invalid Token' });

                const { username, password, presenter } = checkXSS(decodeToken(token));
                peerUsername = username;
                peerPassword = password;
                isPeerValid = isAuthPeer(username, password);
                isPeerPresenter = presenter === '1' || presenter === 'true';
            } catch (err) {
                log.error('Direct Join JWT error', err.message);
                return hostCfg.protected || hostCfg.user_auth
                    ? htmlInjector.injectHtml(views.login, res)
                    : htmlInjector.injectHtml(views.landing, res);
            }
        }

        const OIDCUserAuthenticated = OIDC.enabled && req.oidc.isAuthenticated();
        if ((hostCfg.protected && isPeerValid && isPeerPresenter && !hostCfg.authenticated) || OIDCUserAuthenticated) {
            const ip = getIP(req);
            hostCfg.authenticated = true;
            authHost.setAuthorizedIP(ip, true);
            log.debug('Direct Join user auth as host done', { ip, username: peerUsername, password: peerPassword });
        }

        if (room && (hostCfg.authenticated || isPeerValid)) {
            return htmlInjector.injectHtml(views.client, res);
        } else {
            return htmlInjector.injectHtml(views.login, res);
        }
    }
});

app.get('/join/:roomId', function (req, res) {
    const { roomId } = req.params;
    if (!roomId) { log.warn('/join/:roomId empty', roomId); return res.redirect('/'); }
    if (!Validate.isValidRoomName(roomId)) { log.warn('/join/:roomId invalid', roomId); return res.redirect('/'); }

    const allowRoomAccess = isAllowedRoomAccess('/join/:roomId', req, hostCfg, peers, roomId);
    if (allowRoomAccess) {
        htmlInjector.injectHtml(views.client, res);
    } else if (OIDC.enabled || hostCfg.protected) {
        htmlInjector.injectHtml(views.waitingRoom, res);
    } else {
        res.redirect('/');
    }
});

app.get('/join/\\*', function (req, res) { res.redirect('/'); });

app.get(['/login'], (req, res) => {
    if (hostCfg.protected || hostCfg.user_auth) return htmlInjector.injectHtml(views.login, res);
    res.redirect('/');
});

app.get('/logged', (req, res) => {
    if (!OIDC.enabled && hostCfg.protected) {
        const ip = getIP(req);
        if (allowedIP(ip)) { res.redirect('/'); }
        else { hostCfg.authenticated = false; res.redirect('/login'); }
    } else {
        res.redirect('/');
    }
});

app.post('/login', loginLimiter, (req, res) => {
    const ip = getIP(req);
    log.debug(`Request login to host from: ${ip}`, req.body);

    const safeBody = checkXSS(req.body) || {};
    const { username, password } = safeBody;

    if (!username || !password) {
        log.warn('Login failed: missing username or password', req.body);
        return res.status(400).json({ message: 'Missing username or password' });
    }

    const isPeerValid = isAuthPeer(username, password);

    if (hostCfg.protected && isPeerValid && !hostCfg.authenticated) {
        hostCfg.authenticated = true;
        authHost.setAuthorizedIP(ip, true);
        log.debug('HOST LOGIN OK', { ip, authorized: authHost.isAuthorizedIP(ip) });
        const token = encodeToken({ username, password, presenter: true });
        return res.status(200).json({ message: token });
    }

    if (isPeerValid) {
        log.debug('PEER LOGIN OK', { ip, authorized: true });
        const isPresenter = roomPresenters && roomPresenters.includes(username).toString();
        const token = encodeToken({ username, password, presenter: isPresenter });
        return res.status(200).json({ message: token });
    }

    return res.status(401).json({ message: 'unauthorized' });
});

app.get('/buttons', (req, res) => res.status(200).json({ message: config.buttons ? config.buttons : false }));
app.get('/themes', (req, res) => res.status(200).json({ message: config.themes ? config.themes : false }));
app.get('/brand', (req, res) => {
    res.status(200).json({ message: config.brand && brandHtmlInjection ? config.brand : false });
});

app.get('/:roomId', (req, res) => {
    const { roomId } = checkXSS(req.params);
    if (!roomId) { log.warn('/:roomId empty', roomId); return res.redirect('/'); }
    log.debug('Detected roomId --> redirect to /join?room=roomId');
    res.redirect(`/join/${roomId}`);
});

// ---- API v1 ----

app.get(`${apiBasePath}/stats`, (req, res) => {
    if (api_disabled.includes('stats')) return res.status(403).json({ error: 'Endpoint disabled.' });
    const { host, authorization } = req.headers;
    const api = new ServerApi(host, authorization, api_key_secret);
    if (!api.isAuthorized()) return res.status(403).json({ error: 'Unauthorized!' });
    const { timestamp, totalRooms, totalPeers } = api.getStats(peers);
    res.json({ success: true, timestamp, totalRooms, totalPeers });
    log.debug('MiroTalk get stats - Authorized', { header: req.headers, timestamp, totalRooms, totalPeers });
});

app.post(`${apiBasePath}/token`, (req, res) => {
    if (api_disabled.includes('token')) return res.status(403).json({ error: 'Endpoint disabled.' });
    const { host, authorization } = req.headers;
    const api = new ServerApi(host, authorization, api_key_secret);
    if (!api.isAuthorized()) return res.status(403).json({ error: 'Unauthorized!' });
    const token = api.getToken(req.body);
    res.json({ token });
    log.debug('MiroTalk get token - Authorized', { header: req.headers, token });
});

app.get(`${apiBasePath}/meetings`, (req, res) => {
    if (api_disabled.includes('meetings')) return res.status(403).json({ error: 'Endpoint disabled.' });
    const { host, authorization } = req.headers;
    const api = new ServerApi(host, authorization, api_key_secret);
    if (!api.isAuthorized()) return res.status(403).json({ error: 'Unauthorized!' });
    const meetings = api.getMeetings(peers);
    res.json({ meetings });
    log.debug('MiroTalk get meetings - Authorized', { header: req.headers, meetings });
});

app.post(`${apiBasePath}/meeting`, (req, res) => {
    if (api_disabled.includes('meeting')) return res.status(403).json({ error: 'Endpoint disabled.' });
    const { host, authorization } = req.headers;
    const api = new ServerApi(host, authorization, api_key_secret);
    if (!api.isAuthorized()) return res.status(403).json({ error: 'Unauthorized!' });
    const meetingURL = api.getMeetingURL();
    res.json({ meeting: meetingURL });
    log.debug('MiroTalk get meeting - Authorized', { header: req.headers, meeting: meetingURL });
});

app.post(`${apiBasePath}/join`, (req, res) => {
    if (api_disabled.includes('join')) return res.status(403).json({ error: 'Endpoint disabled.' });
    const { host, authorization } = req.headers;
    const api = new ServerApi(host, authorization, api_key_secret);
    if (!api.isAuthorized()) return res.status(403).json({ error: 'Unauthorized!' });
    const joinURL = api.getJoinURL(req.body);
    res.json({ join: joinURL });
    log.debug('MiroTalk get join - Authorized', { header: req.headers, join: joinURL });
});

app.post('/slack', (req, res) => {
    if (!slackEnabled) return res.end('`Under maintenance` - Please check back soon.');
    if (api_disabled.includes('slack')) return res.end('`Endpoint disabled`.');
    log.debug('Slack', req.headers);
    if (!slackSigningSecret) return res.end('`Slack Signing Secret is empty!`');

    const slackSignature = req.headers['x-slack-signature'];
    const requestBody = qS.stringify(req.body, { format: 'RFC1738' });
    const timeStamp = req.headers['x-slack-request-timestamp'];
    const time = Math.floor(new Date().getTime() / 1000);
    if (Math.abs(time - timeStamp) > 300) return res.end('`Wrong timestamp` - Ignore this request.');

    const sigBaseString = 'v0:' + timeStamp + ':' + requestBody;
    const mySignature = 'v0=' + CryptoJS.HmacSHA256(sigBaseString, slackSigningSecret);
    if (mySignature == slackSignature) {
        const meetingURL = getMeetingURL(req.headers.host);
        log.debug('Slack', { meeting: meetingURL });
        return res.end(meetingURL);
    }
    return res.end('`Wrong signature` - Verification failed!');
});

function getMeetingURL(host) {
    return 'http' + (host.includes('localhost') ? '' : 's') + '://' + host + '/join/' + uuidV4();
}

app.get(`${apiBasePath}/activeRooms`, (req, res) => {
    if (!hostCfg.showActiveRooms) return res.status(403).json({ error: 'Endpoint disabled.' });
    const { host, authorization = api_key_secret } = req.headers;
    const api = new ServerApi(host, authorization, api_key_secret);
    const activeRooms = api.getActiveRooms(peers);
    res.json({ activeRooms });
    log.debug('MiroTalk get active rooms - Authorized', { header: req.headers, activeRooms });
});

// 404
app.use((req, res) => res.sendFile(views.notFound));

// Global error handler
app.use((err, req, res, next) => {
    if (err instanceof URIError) {
        log.warn('Malformed URI detected', { url: req.url, ip: getIP(req), error: err.message });
        return res.status(400).send({ status: 400, message: 'Invalid URL encoding' });
    }
    log.error('Unhandled error', { url: req.url, error: err.message, stack: err.stack });
    res.status(500).send({ status: 500, message: 'Internal server error' });
});

// ----------------------------------------------------------------
// Server config helper
// ----------------------------------------------------------------
function getServerConfig(tunnel = false) {
    return {
        server: host,
        server_tunnel: tunnel,
        trust_proxy: trustProxy,
        api_docs: api_docs,
        jwtCfg: jwtCfg,
        cors: corsOptions,
        iceServers: iceServers,
        test_ice_servers: testStunTurn,
        email: nodemailer.emailCfg.alert ? nodemailer.emailCfg : false,
        oidc: OIDC.enabled ? OIDC : false,
        host_protected: hostCfg.protected || hostCfg.user_auth ? hostCfg : false,
        presenters: roomPresenters,
        ip_whitelist: ipWhitelist.enabled ? ipWhitelist : false,
        api_key_secret: api_key_secret,
        turn_enabled: turnServerEnabled,
        ip_lookup_enabled: IPLookupEnabled,
        chatGPT_enabled: configChatGPT.enabled ? configChatGPT : false,
        slack_enabled: slackEnabled,
        mattermost_enabled: mattermostCfg.enabled ? mattermostCfg : false,
        webhook: webhook.enabled ? webhook : false,
        sentry_enabled: sentryEnabled,
        stats: statsData.enabled ? statsData : false,
        ngrok: ngrokEnabled ? { enabled: ngrokEnabled, token: ngrokAuthToken } : false,
        survey: surveyEnabled ? surveyURL : false,
        redirect: redirectEnabled ? redirectURL : false,
        widget: config.brand?.widget?.enabled ? config.brand.widget : false,
        environment: config.server.environment,
        app_version: packageJson.version,
        node_version: process.versions.node,
    };
}

async function ngrokStart() {
    try {
        await ngrok.authtoken(ngrokAuthToken);
        const listener = await ngrok.forward({ addr: port });
        const tunnelUrl = listener.url();
        log.info('Server config', getServerConfig(tunnelUrl));
    } catch (err) {
        log.warn('[Error] ngrokStart', err);
        await ngrok.kill();
        process.exit(1);
    }
}

// ----------------------------------------------------------------
// Start server
// ----------------------------------------------------------------
server.listen(port, null, async () => {
    log.info(`\n\n  VideoCall App started on port ${port} — http://localhost:${port}\n`);

    if (ngrokEnabled) {
        await ngrokStart();
    } else {
        log.info('Server config', getServerConfig());
    }

    if (api_key_secret === 'webrtc_api_secret') {
        log.warn('WARNING: API_KEY_SECRET is set to the default value. Change it before deploying!');
    }
    if (jwtCfg.JWT_KEY === 'webrtc_jwt_secret_key') {
        log.warn('WARNING: JWT_KEY is set to the default value. Change it before deploying!');
    }
});

// ----------------------------------------------------------------
// Socket.IO — WebRTC signalling
// ----------------------------------------------------------------
io.sockets.on('connect', async (socket) => {
    log.debug('[' + socket.id + '] connection accepted', {
        host: socket.handshake.headers.host.split(':')[0],
        time: socket.handshake.time,
    });

    socket.channels = {};
    sockets[socket.id] = socket;

    const transport = socket.conn.transport.name;
    log.debug('[' + socket.id + '] Connection transport', transport);

    socket.conn.on('upgrade', () => {
        log.debug('[' + socket.id + '] Connection upgraded transport', socket.conn.transport.name);
    });

    socket.on('disconnect', async (reason) => {
        removeIP(socket);
        for (let channel in socket.channels) await removePeerFrom(channel, socket, reason);
        log.debug('[' + socket.id + '] disconnected', { reason });
        delete sockets[socket.id];
    });

    socket.on('data', async (dataObj, cb) => {
        const data = checkXSS(dataObj);
        log.debug('Socket Promise', data);
        if (!Validate.isValidData(data)) return;

        const { room_id, peer_id, peer_name, method, params } = data;

        switch (method) {
            case 'checkPeerName':
                log.debug('Check if peer name exists', { peer_name, room_id });
                for (let id in peers[room_id]) {
                    if (peer_id != id && peers[room_id][id]['peer_name'] == peer_name) {
                        log.debug('Peer name found', { peer_name, room_id });
                        cb(true);
                        break;
                    }
                }
                break;
            case 'getChatGPT':
                if (!configChatGPT.enabled) return cb({ message: 'ChatGPT is disabled.' });
                try {
                    const { time, prompt, context } = params;
                    context.push({ role: 'user', content: prompt });
                    const MAX_CONTEXT_MESSAGES = 20;
                    if (context.length > MAX_CONTEXT_MESSAGES) {
                        const systemMessage = context[0]?.role === 'system' ? [context[0]] : [];
                        const recentMessages = context.slice(-MAX_CONTEXT_MESSAGES);
                        context.length = 0;
                        context.push(...systemMessage, ...recentMessages);
                    }
                    const completion = await chatGPT.chat.completions.create({
                        model: configChatGPT.model || 'gpt-3.5-turbo',
                        messages: context,
                        max_tokens: configChatGPT.max_tokens || 1000,
                        temperature: configChatGPT.temperature || 0,
                    });
                    const message = completion.choices[0].message.content.trim();
                    context.push({ role: 'assistant', content: message });
                    log.debug('ChatGPT', { time, room: room_id, name: peer_name, contextLength: context.length });
                    cb({ message, context });
                } catch (error) {
                    log.error('ChatGPT', error);
                    cb({ message: error.message });
                }
                break;
            default:
                cb(false);
                break;
        }
        cb(false);
    });

    socket.on('join', async (cfg) => {
        const peer_ip = getSocketIP(socket);
        if (IPLookupEnabled && peer_ip != '::1') cfg.peer_geo = await getPeerGeoLocation(peer_ip);

        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;

        log.debug('[' + socket.id + '] join ', config);

        const {
            channel, channel_password, peer_uuid, peer_name, peer_avatar, peer_token,
            peer_video, peer_audio, peer_video_status, peer_audio_status, peer_screen_status,
            peer_hand_status, peer_rec_status, peer_privacy_status, peer_info,
        } = config;

        if (!Validate.isValidRoomName(channel)) {
            log.warn('[' + socket.id + '] - Invalid room name', channel);
            return socket.emit('unauthorized');
        }
        if (channel in socket.channels) return log.debug('[' + socket.id + '] [Warning] already joined', channel);
        if (!(channel in channels)) channels[channel] = {};
        if (!(channel in peers)) peers[channel] = {};
        if (!(channel in presenters)) presenters[channel] = {};

        let is_presenter = true;

        if (hostCfg.user_auth || peer_token) {
            if (peer_token) {
                try {
                    const validToken = await isValidToken(peer_token);
                    if (!validToken) return socket.emit('unauthorized');

                    const { username, password, presenter } = checkXSS(decodeToken(peer_token));
                    const isPeerValid = isAuthPeer(username, password);
                    if (!isPeerValid) return socket.emit('unauthorized');

                    is_presenter =
                        presenter === '1' || presenter === 'true' || Object.keys(presenters[channel]).length === 0;
                    log.debug('[' + socket.id + '] JOIN ROOM - USER AUTH check peer', {
                        ip: peer_ip, peer_username: username, peer_valid: isPeerValid, peer_presenter: is_presenter,
                    });
                } catch (err) {
                    log.error('[' + socket.id + '] [Warning] Join Room JWT error', err.message);
                    return socket.emit('unauthorized');
                }
            } else {
                return socket.emit('unauthorized');
            }
        }

        if (peers[channel]['lock'] === true && peers[channel]['password'] != channel_password) {
            log.debug('[' + socket.id + '] [Warning] Room Is Locked', channel);
            return socket.emit('roomIsLocked');
        }

        const presenter = { peer_ip, peer_name, peer_uuid, is_presenter };
        if (roomPresenters && roomPresenters.includes(peer_name)) {
            presenters[channel][socket.id] = presenter;
        } else if (Object.keys(presenters[channel]).length === 0) {
            presenters[channel][socket.id] = presenter;
        }

        const isPresenter = peer_token ? is_presenter : isPeerPresenter(channel, socket.id, peer_name, peer_uuid);
        const { osName, osVersion, browserName, browserVersion, extras } = peer_info;

        peers[channel][socket.id] = {
            peer_name, peer_avatar, peer_presenter: isPresenter, peer_video, peer_audio,
            peer_video_status, peer_audio_status, peer_screen_status, peer_hand_status,
            peer_rec_status, peer_privacy_status,
            os: osName ? `${osName} ${osVersion}` : '',
            browser: browserName ? `${browserName} ${browserVersion}` : '',
            extras,
        };

        const activeRooms = getActiveRooms();
        log.debug('[Join] - active rooms and peers count', activeRooms);
        log.debug('[Join] - connected presenters grp by roomId', presenters);
        log.debug('[Join] - connected peers grp by roomId', peers);

        await addPeerTo(channel);
        channels[channel][socket.id] = socket;
        socket.channels[channel] = channel;

        const peerCounts = getPeerCount(channel);
        await sendToPeer(socket.id, sockets, 'serverInfo', {
            peers_count: peerCounts,
            host_protected: hostCfg.protected,
            user_auth: hostCfg.user_auth,
            is_presenter: isPresenter,
            survey: { active: surveyEnabled, url: surveyURL },
            redirect: { active: redirectEnabled, url: redirectURL },
            maxRoomParticipants: hostCfg.maxRoomParticipants,
        });

        if (peerCounts === 1) {
            nodemailer.sendEmailAlert('join', {
                room_id: channel, peer_name,
                domain: socket.handshake.headers.host.split(':')[0],
                os: osName ? `${osName} ${osVersion}` : '',
                browser: browserName ? `${browserName} ${browserVersion}` : '',
            });
        }

        if (webhook.enabled) {
            config.timestamp = log.getDateTime(false);
            axios.post(webhook.url, { event: 'join', data: config }, { timeout: 5000 })
                .then((r) => log.debug('Join event tracked:', r.data))
                .catch((e) => log.error('Error tracking join event:', e.message));
        }
    });

    socket.on('relayICE', async (config) => {
        if (!Validate.isValidData(config)) return;
        const { peer_id, ice_candidate } = config;
        await sendToPeer(peer_id, sockets, 'iceCandidate', { peer_id: socket.id, ice_candidate });
    });

    socket.on('relaySDP', async (config) => {
        if (!Validate.isValidData(config)) return;
        const { peer_id, session_description } = config;
        log.debug('[' + socket.id + '] relay SessionDescription to [' + peer_id + '] ', { type: session_description.type });
        await sendToPeer(peer_id, sockets, 'sessionDescription', { peer_id: socket.id, session_description });
    });

    socket.on('roomAction', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { room_id, peer_id, peer_name, peer_uuid, password, action } = config;
        if (!peers[room_id]) return;
        const isPresenter = isPeerPresenter(room_id, peer_id, peer_name, peer_uuid);
        let room_is_locked = false;
        try {
            switch (action) {
                case 'lock':
                    if (!isPresenter) return;
                    peers[room_id]['lock'] = true;
                    peers[room_id]['password'] = password;
                    await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                    room_is_locked = true;
                    break;
                case 'unlock':
                    if (!isPresenter) return;
                    delete peers[room_id]['lock'];
                    delete peers[room_id]['password'];
                    await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                    break;
                case 'checkPassword':
                    await sendToPeer(socket.id, sockets, 'roomAction', {
                        peer_name, action,
                        password: password == peers[room_id]['password'] ? 'OK' : 'KO',
                    });
                    break;
                default:
                    break;
            }
        } catch (err) {
            log.error('Room action', JSON.stringify(err, null, 4));
        }
        log.debug('[' + socket.id + '] Room ' + room_id, { locked: room_is_locked, password });
    });

    socket.on('peerName', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { room_id, peer_name_old, peer_name_new, peer_avatar } = config;
        let peer_id_to_update = null;
        for (let peer_id in peers[room_id]) {
            if (peer_id == socket.id) {
                peers[room_id][peer_id]['peer_name'] = peer_name_new;
                peers[room_id][peer_id]['peer_avatar'] = peer_avatar;
                if (presenters && presenters[room_id] && presenters[room_id][peer_id]) {
                    presenters[room_id][peer_id]['peer_name'] = peer_name_new;
                }
                peer_id_to_update = peer_id;
                log.debug('[' + socket.id + '] Peer profile changed', { peer_name_old, peer_name_new });
                break;
            }
        }
        if (peer_id_to_update) {
            const data = { peer_id: peer_id_to_update, peer_name: peer_name_new, peer_avatar };
            log.debug('[' + socket.id + '] emit peerName to [room_id: ' + room_id + ']', data);
            await sendToRoom(room_id, socket.id, 'peerName', data);
        }
    });

    socket.on('message', async (message) => {
        const data = checkXSS(message);
        log.debug('Got message', data);
        if (!Validate.isValidData(data)) return;
        await sendToRoom(data.room_id, socket.id, 'message', data);
    });

    socket.on('cmd', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { action, send_to_all, data } = config;
        const { room_id, peer_id, peer_name, peer_uuid, to_peer_id } = data;
        log.debug('cmd', config);
        const presenterActions = ['geoLocation'];
        if (presenterActions.some((v) => action === v)) {
            if (!isPeerPresenter(room_id, peer_id, peer_name, peer_uuid)) return;
        }
        if (send_to_all) {
            log.debug('[' + socket.id + '] emit cmd to [room_id: ' + room_id + ']', config);
            await sendToRoom(room_id, socket.id, 'cmd', config);
        } else {
            log.debug('[' + socket.id + '] emit cmd to [' + to_peer_id + '] from room_id [' + room_id + ']');
            await sendToPeer(to_peer_id, sockets, 'cmd', config);
        }
    });

    socket.on('peerStatus', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { room_id, peer_name, peer_id, element, status, extras } = config;
        const data = { peer_id, peer_name, element, status, extras };
        try {
            for (let pid in peers[room_id]) {
                if (peers[room_id][pid]['peer_name'] == peer_name && pid == socket.id) {
                    switch (element) {
                        case 'video': peers[room_id][pid]['peer_video_status'] = status; break;
                        case 'audio': peers[room_id][pid]['peer_audio_status'] = status; break;
                        case 'screen':
                            peers[room_id][pid]['peer_screen_status'] = status;
                            if (extras) peers[room_id][pid]['extras'] = extras;
                            break;
                        case 'hand': peers[room_id][pid]['peer_hand_status'] = status; break;
                        case 'rec': peers[room_id][pid]['peer_rec_status'] = status; break;
                        case 'privacy': peers[room_id][pid]['peer_privacy_status'] = status; break;
                        default: break;
                    }
                }
            }
            log.debug('[' + socket.id + '] emit peerStatus to [room_id: ' + room_id + ']', data);
            await sendToRoom(room_id, socket.id, 'peerStatus', data);
        } catch (err) {
            log.error('Peer Status', JSON.stringify(err, null, 4));
        }
    });

    socket.on('peerAction', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { room_id, peer_id, peer_uuid, peer_name, peer_avatar, peer_use_video, peer_action, extras, send_to_all } = config;
        const presenterActions = ['muteAudio', 'hideVideo', 'ejectAll'];
        if (presenterActions.some((v) => peer_action === v)) {
            if (!isPeerPresenter(room_id, peer_id, peer_name, peer_uuid)) return;
        }
        const data = { peer_id, peer_name, peer_avatar, peer_action, peer_use_video, extras };
        if (send_to_all) {
            await sendToRoom(room_id, socket.id, 'peerAction', data);
        } else {
            await sendToPeer(peer_id, sockets, 'peerAction', data);
        }
    });

    socket.on('caption', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        await sendToRoom(cfg.room_id, sockets, 'caption', config);
    });

    socket.on('kickOut', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { room_id, peer_id, peer_uuid, peer_name } = config;
        const isPresenter = await isPeerPresenter(room_id, peer_id, peer_name, peer_uuid);
        if (isPresenter) {
            log.debug('[' + socket.id + '] kick out peer [' + peer_id + '] from room_id [' + room_id + ']');
            await sendToPeer(peer_id, sockets, 'kickOut', { peer_name });
        }
    });

    socket.on('fileInfo', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { room_id, peer_id, peer_name, peer_avatar, broadcast, file } = config;
        if (!isValidFileName(file.fileName)) { log.debug('[' + socket.id + '] File name not valid', config); return; }
        function bytesToSize(bytes) {
            let sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            if (bytes == 0) return '0 Byte';
            let i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
            return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
        }
        log.debug('[' + socket.id + '] Peer [' + peer_name + '] send file to room_id [' + room_id + ']', {
            peerName: peer_name, fileName: file.fileName, fileSize: bytesToSize(file.fileSize), broadcast,
        });
        if (broadcast) {
            await sendToRoom(room_id, socket.id, 'fileInfo', config);
        } else {
            await sendToPeer(peer_id, sockets, 'fileInfo', config);
        }
    });

    socket.on('fileAbort', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { room_id, peer_name } = config;
        log.debug('[' + socket.id + '] Peer [' + peer_name + '] send fileAbort to room_id [' + room_id + ']');
        await sendToRoom(room_id, socket.id, 'fileAbort');
    });

    socket.on('fileReceiveAbort', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { room_id, peer_name } = config;
        log.debug('[' + socket.id + '] Peer [' + peer_name + '] send fileReceiveAbort to room_id [' + room_id + ']');
        await sendToRoom(room_id, socket.id, 'fileReceiveAbort', config);
    });

    socket.on('videoPlayer', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { room_id, peer_id, peer_name, video_action, video_src, broadcast } = config;
        if (video_action == 'open' && !isValidHttpURL(video_src)) {
            log.debug('[' + socket.id + '] Video src not valid', config); return;
        }
        const data = { peer_id: socket.id, peer_name, video_action, video_src, broadcast };
        if (peer_id) {
            await sendToPeer(peer_id, sockets, 'videoPlayer', data);
        } else {
            await sendToRoom(room_id, socket.id, 'videoPlayer', data);
        }
    });

    socket.on('wbCanvasToJson', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        const { room_id } = config;
        await sendToRoom(room_id, socket.id, 'wbCanvasToJson', config);
    });

    socket.on('whiteboardAction', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;
        log.debug('Whiteboard', config);
        const { room_id } = config;
        await sendToRoom(room_id, socket.id, 'whiteboardAction', config);
    });

    async function addPeerTo(channel) {
        for (let id in channels[channel]) {
            await channels[channel][id].emit('addPeer', {
                peer_id: socket.id, peers: peers[channel], should_create_offer: false, iceServers,
            });
            socket.emit('addPeer', {
                peer_id: id, peers: peers[channel], should_create_offer: true, iceServers,
            });
            log.debug('[' + socket.id + '] emit addPeer [' + id + ']');
        }
    }

    async function removePeerFrom(channel, socket, reason = 'unknown') {
        if (!(channel in socket.channels)) return log.debug('[' + socket.id + '] [Warning] not in ', channel);
        try {
            if (webhook.enabled) {
                const data = { timestamp: log.getDateTime(false), room_id: channel, peer: socket.channels[channel], reason };
                axios.post(webhook.url, { event: 'disconnect', data }, { timeout: 5000 })
                    .then((r) => log.debug('Disconnect event tracked:', r.data))
                    .catch((e) => log.error('Error tracking disconnect event:', e.message));
            }
            delete socket.channels[channel];
            delete channels[channel][socket.id];
            delete peers[channel][socket.id];
            if (getPeerCount(channel) === 0) {
                delete peers[channel];
                delete presenters[channel];
                delete channels[channel];
            }
        } catch (err) {
            log.error('Remove Peer', JSON.stringify(err, null, 4));
        }

        log.debug('[removePeerFrom] - active rooms and peers count', getActiveRooms());
        log.debug('[removePeerFrom] - connected presenters grp by roomId', presenters);
        log.debug('[removePeerFrom] - connected peers grp by roomId', peers);

        for (let id in channels[channel]) {
            await channels[channel][id].emit('removePeer', { peer_id: socket.id });
            socket.emit('removePeer', { peer_id: id });
            log.debug('[' + socket.id + '] emit removePeer [' + id + ']');
        }

        if (!OIDC.enabled && hostCfg.protected) {
            hostCfg.authenticated = false;
            removeIP(socket);
        }
    }

    async function sendToRoom(room_id, socket_id, msg, config = {}) {
        for (let peer_id in channels[room_id]) {
            if (peer_id != socket_id) await channels[room_id][peer_id].emit(msg, config);
        }
    }

    async function sendToPeer(peer_id, sockets, msg, config = {}) {
        if (peer_id in sockets) await sockets[peer_id].emit(msg, config);
    }
});

// ----------------------------------------------------------------
// Utility functions
// ----------------------------------------------------------------
function isValidFileName(fileName) {
    return !/[\\\/\?\*\|:"<>]/.test(fileName);
}

function isValidHttpURL(input) {
    try {
        const url = new URL(input);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

async function getPeerGeoLocation(ip) {
    const endpoint = `https://get.geojs.io/v1/ip/geo/${ip}.json`;
    log.debug('Get peer geo', { ip, endpoint });
    return axios.get(endpoint).then((r) => r.data).catch((e) => log.error(e));
}

function isPeerPresenter(room_id, peer_id, peer_name, peer_uuid) {
    try {
        if (!presenters[room_id] || !presenters[room_id][peer_id]) {
            for (const [, presenter] of Object.entries(presenters[room_id] || {})) {
                if (presenter.peer_name === peer_name) return true;
            }
            return false;
        }
        const isPresenter =
            (typeof presenters[room_id] === 'object' &&
                Object.keys(presenters[room_id][peer_id]).length > 1 &&
                presenters[room_id][peer_id]['peer_name'] === peer_name &&
                presenters[room_id][peer_id]['peer_uuid'] === peer_uuid) ||
            (roomPresenters && roomPresenters.includes(peer_name));
        log.debug('[' + peer_id + '] isPeerPresenter', presenters[room_id][peer_id]);
        return isPresenter;
    } catch (err) {
        log.error('isPeerPresenter', err);
        return false;
    }
}

function isAuthPeer(username, password) {
    return hostCfg.users && hostCfg.users.some((user) => user.username === username && user.password === password);
}

async function isValidToken(token) {
    return new Promise((resolve) => {
        jwt.verify(token, jwtCfg.JWT_KEY, (err) => resolve(!err));
    });
}

function encodeToken(token) {
    if (!token) return '';
    const { username = 'username', password = 'password', presenter = false, expire } = token;
    const expireValue = expire || jwtCfg.JWT_EXP;
    const payload = { username: String(username), password: String(password), presenter: String(presenter) };
    const encryptedPayload = CryptoJS.AES.encrypt(JSON.stringify(payload), jwtCfg.JWT_KEY).toString();
    return jwt.sign({ data: encryptedPayload }, jwtCfg.JWT_KEY, { expiresIn: expireValue });
}

function decodeToken(jwtToken) {
    if (!jwtToken) return null;
    const decodedToken = jwt.verify(jwtToken, jwtCfg.JWT_KEY);
    if (!decodedToken || !decodedToken.data) throw new Error('Invalid token');
    const decryptedPayload = CryptoJS.AES.decrypt(decodedToken.data, jwtCfg.JWT_KEY).toString(CryptoJS.enc.Utf8);
    return JSON.parse(decryptedPayload);
}

function getActiveRooms() {
    return Object.keys(peers)
        .filter((roomId) => peers.hasOwnProperty(roomId))
        .map((roomId) => ({ roomId, peersCount: getPeerCount(roomId) }));
}

function isAllowedRoomAccess(logMessage, req, hostCfg, peers, roomId) {
    const OIDCUserAuthenticated = OIDC.enabled && req.oidc.isAuthenticated();
    const OIDCAllowRoomCreationForAuthUsers = OIDC.allowRoomCreationForAuthUsers;
    const hostUserAuthenticated = hostCfg.protected && hostCfg.authenticated;
    const roomExist = roomId in peers;
    const roomCount = Object.keys(peers).length;

    const allowRoomAccess =
        (!hostCfg.protected && !OIDC.enabled) ||
        (OIDCUserAuthenticated && roomExist) ||
        (hostUserAuthenticated && roomExist) ||
        ((OIDCUserAuthenticated || hostUserAuthenticated) && roomCount === 0) ||
        (OIDCUserAuthenticated && OIDCAllowRoomCreationForAuthUsers) ||
        roomExist;

    log.debug(logMessage, {
        OIDCUserAuthenticated, hostUserAuthenticated, roomExist, roomCount,
        extraInfo: { roomId, OIDCUserEnabled: OIDC.enabled, hostProtected: hostCfg.protected, hostAuthenticated: hostCfg.authenticated },
        allowRoomAccess,
    });
    return allowRoomAccess;
}

function getIP(req) {
    const forwarded = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || req.ip;
}

function getSocketIP(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'] || socket.handshake.headers['X-Forwarded-For'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return socket.handshake.address;
}

function allowedIP(ip) {
    log.info('Allowed IPs', { ip, authorizedIP: authHost.isAuthorizedIP(ip), authorizedIPs: authHost.getAuthorizedIPs() });
    return authHost != null && authHost.isAuthorizedIP(ip);
}

function removeIP(socket) {
    if (hostCfg.protected) {
        const ip = getSocketIP(socket);
        log.debug('[removeIP] - Host protected check ip', { ip });
        if (ip && allowedIP(ip)) {
            authHost.deleteIP(ip);
            hostCfg.authenticated = false;
            log.info('[removeIP] - Remove IP from auth', { ip, authorizedIps: authHost.getAuthorizedIPs() });
        }
    }
}

process.on('SIGINT', () => { log.debug('PROCESS', 'SIGINT'); htmlInjector.cleanup(); process.exit(); });
process.on('SIGTERM', () => { log.debug('PROCESS', 'SIGTERM'); htmlInjector.cleanup(); process.exit(); });
