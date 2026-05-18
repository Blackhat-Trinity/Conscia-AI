'use strict';

/**
 * ==============================================
 * VideoCall App — Configuration File
 * ==============================================
 *
 * This file is the central configuration source.
 * All environment variables are read here so the
 * rest of the codebase imports config values
 * instead of reading process.env directly.
 *
 * Setup:
 *   cp app/src/config.template.js app/src/config.js
 *   Then edit config.js to match your environment.
 *
 * Docker/container environments inject values via
 * environment variables which are read at startup.
 */

require('dotenv').config();

const packageJson = require('../../package.json');

// Helper: parse env string to boolean
function getEnvBoolean(key, force_true_if_undefined = false) {
    if (key == undefined && force_true_if_undefined) return true;
    return key == 'true' ? true : false;
}

// Helper: safely parse JSON env vars with a fallback
function parseJsonEnv(envValue, fallback) {
    if (!envValue) return fallback;
    try {
        return JSON.parse(envValue);
    } catch (e) {
        return fallback;
    }
}

const port = process.env.PORT || 3000;

module.exports = {
    // ==========================================
    // Server
    // ==========================================
    server: {
        port: port,
        host: process.env.HOST || `http://localhost:${port}`,
        environment: process.env.NODE_ENV || 'development',
        trustProxy: !!getEnvBoolean(process.env.TRUST_PROXY),
    },

    // ==========================================
    // CORS
    // ==========================================
    cors: {
        origin: parseJsonEnv(process.env.CORS_ORIGIN, '*'),
        methods: parseJsonEnv(process.env.CORS_METHODS, ['GET', 'POST']),
    },

    // ==========================================
    // Host Protection
    // ==========================================
    host: {
        protected: getEnvBoolean(process.env.HOST_PROTECTED),
        userAuth: getEnvBoolean(process.env.HOST_USER_AUTH),
        users: parseJsonEnv(process.env.HOST_USERS, [{ username: 'admin', password: 'admin' }]),
        maxLoginAttempts: process.env.HOST_MAX_LOGIN_ATTEMPTS || 5,
        minLoginBlockTime: process.env.HOST_MIN_LOGIN_BLOCK_TIME || 15, // in minutes
        maxRoomParticipants: parseInt(process.env.ROOM_MAX_PARTICIPANTS) || 1000,
        showActiveRooms: getEnvBoolean(process.env.SHOW_ACTIVE_ROOMS) || false,
    },

    // ==========================================
    // JWT
    // ==========================================
    jwt: {
        key: process.env.JWT_KEY || 'videocall_jwt_secret_change_me',
        exp: process.env.JWT_EXP || '1h',
    },

    // ==========================================
    // Presenters
    // ==========================================
    presenters: parseJsonEnv(process.env.PRESENTERS, ['Admin']),

    // ==========================================
    // API
    // ==========================================
    api: {
        keySecret: process.env.API_KEY_SECRET,
        disabled: parseJsonEnv(process.env.API_DISABLED, ['token', 'meetings']),
    },

    // ==========================================
    // Ngrok
    // ==========================================
    ngrok: {
        enabled: getEnvBoolean(process.env.NGROK_ENABLED),
        authToken: process.env.NGROK_AUTH_TOKEN,
    },

    // ==========================================
    // WebRTC ICE Servers
    // ==========================================
    webrtc: {
        stun: {
            enabled: getEnvBoolean(process.env.STUN_SERVER_ENABLED, true),
            url: process.env.STUN_SERVER_URL || 'stun:stun.l.google.com:19302',
        },
        turn: {
            enabled: getEnvBoolean(process.env.TURN_SERVER_ENABLED),
            url: process.env.TURN_SERVER_URL,
            username: process.env.TURN_SERVER_USERNAME,
            credential: process.env.TURN_SERVER_CREDENTIAL,
        },
    },

    // ==========================================
    // IP Lookup
    // ==========================================
    ipLookup: {
        enabled: getEnvBoolean(process.env.IP_LOOKUP_ENABLED),
    },

    // ==========================================
    // Survey
    // ==========================================
    survey: {
        enabled: getEnvBoolean(process.env.SURVEY_ENABLED),
        url: process.env.SURVEY_URL || '',
    },

    // ==========================================
    // Redirect
    // ==========================================
    redirect: {
        enabled: getEnvBoolean(process.env.REDIRECT_ENABLED),
        url: process.env.REDIRECT_URL || '/newcall',
    },

    // ==========================================
    // Sentry
    // ==========================================
    sentry: {
        enabled: getEnvBoolean(process.env.SENTRY_ENABLED),
        dsn: process.env.SENTRY_DSN,
        tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.0'),
        logLevels: process.env.SENTRY_LOG_LEVELS
            ? process.env.SENTRY_LOG_LEVELS.split(',').map((level) => level.trim())
            : ['error'],
    },

    // ==========================================
    // Slack
    // ==========================================
    slack: {
        enabled: getEnvBoolean(process.env.SLACK_ENABLED),
        signingSecret: process.env.SLACK_SIGNING_SECRET,
    },

    // ==========================================
    // ChatGPT / OpenAI
    // ==========================================
    chatGPT: {
        enabled: getEnvBoolean(process.env.CHATGPT_ENABLED),
        basePath: process.env.CHATGPT_BASE_PATH,
        apiKey: process.env.CHATGPT_APIKEY,
        model: process.env.CHATGPT_MODEL,
        max_tokens: parseInt(process.env.CHATGPT_MAX_TOKENS),
        temperature: parseInt(process.env.CHATGPT_TEMPERATURE),
    },

    // ==========================================
    // IP Whitelist
    // ==========================================
    ipWhitelist: {
        enabled: getEnvBoolean(process.env.IP_WHITELIST_ENABLED),
        allowed: parseJsonEnv(process.env.IP_WHITELIST_ALLOWED, []),
    },

    // ==========================================
    // OIDC - OpenID Connect
    // ==========================================
    oidc: {
        enabled: process.env.OIDC_ENABLED ? getEnvBoolean(process.env.OIDC_ENABLED) : false,
        allowRoomCreationForAuthUsers: process.env.OIDC_ALLOW_ROOMS_CREATION_FOR_AUTH_USERS
            ? getEnvBoolean(process.env.OIDC_ALLOW_ROOMS_CREATION_FOR_AUTH_USERS)
            : false,
        baseUrlDynamic: process.env.OIDC_BASE_URL_DYNAMIC ? getEnvBoolean(process.env.OIDC_BASE_URL_DYNAMIC) : false,
        config: {
            issuerBaseURL: process.env.OIDC_ISSUER_BASE_URL,
            clientID: process.env.OIDC_CLIENT_ID,
            clientSecret: process.env.OIDC_CLIENT_SECRET,
            baseURL: process.env.OIDC_BASE_URL,
            secret: process.env.SESSION_SECRET,
            authorizationParams: {
                response_type: 'code',
                scope: 'openid profile email',
            },
            authRequired: process.env.OIDC_AUTH_REQUIRED ? getEnvBoolean(process.env.OIDC_AUTH_REQUIRED) : false,
            auth0Logout: process.env.OIDC_AUTH_LOGOUT ? getEnvBoolean(process.env.OIDC_AUTH_LOGOUT) : true,
            routes: {
                callback: '/auth/callback',
                login: false,
                logout: '/logout',
            },
        },
    },

    // ==========================================
    // Mattermost
    // ==========================================
    mattermost: {
        enabled: getEnvBoolean(process.env.MATTERMOST_ENABLED),
        serverUrl: process.env.MATTERMOST_SERVER_URL,
        username: process.env.MATTERMOST_USERNAME,
        password: process.env.MATTERMOST_PASSWORD,
        token: process.env.MATTERMOST_TOKEN,
        roomTokenExpire: process.env.MATTERMOST_ROOM_TOKEN_EXPIRE,
    },

    // ==========================================
    // Stats / Analytics — disabled by default (no external tracking)
    // ==========================================
    stats: {
        enabled: process.env.STATS_ENABLED ? getEnvBoolean(process.env.STATS_ENABLED) : false,
        src: process.env.STATS_SCR || '',
        id: process.env.STATS_ID || '',
    },

    // ==========================================
    // Email
    // ==========================================
    email: {
        alert: process.env.EMAIL_ALERT === 'true' || false,
        host: process.env.EMAIL_HOST,
        port: Number(process.env.EMAIL_PORT),
        username: process.env.EMAIL_USERNAME,
        password: process.env.EMAIL_PASSWORD,
        from: process.env.EMAIL_FROM || process.env.EMAIL_USERNAME,
        sendTo: process.env.EMAIL_SEND_TO,
        https: process.env.HTTPS === 'true' || false,
        serverPort: process.env.PORT || 3000,
    },

    // ==========================================
    // Branding (UI customizations)
    // ==========================================
    brand: {
        htmlInjection: true,
        app: {
            language: 'en',
            name: 'VideoCall',
            title: '<h1>VideoCall</h1>Private peer-to-peer WebRTC video calls.<br />No accounts. No servers.',
            description:
                'Start a private video call instantly. No downloads, no plugins, no sign-ups. Just share a room link and connect directly — end-to-end encrypted.',
            joinDescription: 'Pick a room name.<br />How about this one?',
            joinButtonLabel: 'JOIN ROOM',
            customizeRoomButtonLabel: 'CUSTOMIZE ROOM',
            joinLastLabel: 'Your recent room:',
        },
        og: {
            type: 'website',
            siteName: 'VideoCall',
            title: 'Click the link to start a private video call.',
            description:
                'Private peer-to-peer video calls. No account, no server, no tracking. Just click and connect.',
            image: '/images/preview.png',
            url: process.env.HOST || `http://localhost:${port}`,
        },
        site: {
            shortcutIcon: '../images/logo.svg',
            appleTouchIcon: '../images/logo.svg',
            landingTitle: 'VideoCall — Private WebRTC Video Calls.',
            newCallTitle: 'VideoCall — Start or Join a Room.',
            newCallRoomTitle: 'Pick name. <br />Share URL. <br />Start call.',
            newCallRoomDescription:
                'Each room has a unique disposable URL. Pick a name, share it with whoever you want in the call — that\'s all it takes.',
            loginTitle: 'VideoCall — Login Required.',
            loginHeading: 'Welcome back',
            loginDescription: 'Enter your credentials to continue.',
            loginButtonLabel: 'Login',
            joinRoomTitle: 'Pick name.<br />Share URL.<br />Start call.',
            joinRoomButtonLabel: 'JOIN ROOM',
            clientTitle: 'VideoCall — WebRTC Video Call.',
            privacyPolicyTitle: 'VideoCall — Privacy Policy.',
            stunTurnTitle: 'Test STUN/TURN Servers.',
            notFoundTitle: 'VideoCall — 404 Not Found.',
            waitingRoomTitle: 'VideoCall — Waiting for host',
            waitingRoomHeading: 'Waiting for host...',
            waitingRoomDescription:
                "The meeting hasn't started yet.<br />You'll join automatically when the host opens the room.",
            waitingRoomStatus: 'Checking room status...',
            waitingRoomReady: 'Room is ready! Joining...',
            waitingRoomWaiting: 'Waiting for host to start the meeting...',
            waitingRoomHostLink: 'Are you the host?',
            waitingRoomLoginLink: 'Login here',
            waitingRoomElapsedJust: 'Just started waiting',
            waitingRoomElapsedMinutes: 'Waiting for {minutes}',
            waitingRoomSongUrl: '../sounds/waiting-music.mp3',
        },
        html: {
            topSponsors: false,
            features: true,
            browsers: true,
            teams: false,
            tryEasier: true,
            poweredBy: false,
            sponsors: false,
            pastSponsors: false,
            advertisers: false,
            supportUs: false,
            footer: true,
        },
        about: {
            imageUrl: '../images/logo.svg',
            title: `VideoCall App v${packageJson.version}`,
            html: `
                <br />
                <p style="color:#a89eff;">A private peer-to-peer WebRTC video calling application.</p>
                <p style="color:#959cb1;font-size:14px;">Built on open web standards. No tracking. No accounts. No servers in the media path.</p>
                <hr />
                <span style="color:rgba(255,255,255,0.4);font-size:12px;">&copy; ${new Date().getFullYear()} VideoCall App. Private Project. All rights reserved.</span>
                <hr />
            `,
        },
        widget: {
            enabled: false,
        },
    },
    // ==========================================
    // Themes
    // ==========================================
    themes: {},
    // ==========================================
    // Buttons
    // ==========================================
    buttons: {
        main: {
            showAudioBtn: true,
            showVideoBtn: true,
            showScreenBtn: true,
            showMyHandBtn: true,
            showChatRoomBtn: true,
            showParticipantsBtn: true,
            showMySettingsBtn: true,
            showExtraBtn: true,
            showShareQr: true,
            showShareRoomBtn: true,
            showHideMeBtn: true,
            showRecordStreamBtn: true,
            showFullScreenBtn: true,
            showRoomEmojiPickerBtn: true,
            showCaptionRoomBtn: true,
            showWhiteboardBtn: true,
            showSnapshotRoomBtn: true,
            showFileShareBtn: true,
            showDocumentPipBtn: true,
            showAboutBtn: true,
        },
        chat: {
            showTogglePinBtn: true,
            showMaxBtn: true,
            showSaveMessageBtn: true,
            showMarkDownBtn: true,
            showChatGPTBtn: getEnvBoolean(process.env.CHATGPT_ENABLED, true),
            showFileShareBtn: true,
            showShareVideoAudioBtn: true,
            showParticipantsBtn: true,
        },
        caption: {
            showTogglePinBtn: true,
            showMaxBtn: true,
        },
        settings: {
            showActiveRoomsBtn: true,
            showMicOptionsBtn: true,
            showTabRoomPeerName: true,
            showTabRoomParticipants: true,
            showTabRoomSecurity: true,
            showTabEmailInvitation: true,
            showCaptionEveryoneBtn: true,
            showMuteEveryoneBtn: true,
            showHideEveryoneBtn: true,
            showEjectEveryoneBtn: true,
            showLockRoomBtn: true,
            showUnlockRoomBtn: true,
            showShortcutsBtn: true,
            customNoiseSuppression: getEnvBoolean(process.env.CUSTOM_NOISE_SUPPRESSION_ENABLED, true),
        },
        remote: {
            showAudioVolume: true,
            audioBtnClickAllowed: true,
            videoBtnClickAllowed: true,
            showVideoPipBtn: true,
            showKickOutBtn: true,
            showSnapShotBtn: true,
            showFileShareBtn: true,
            showShareVideoAudioBtn: true,
            showGeoLocationBtn: true,
            showPrivateMessageBtn: true,
            showZoomInOutBtn: false,
            showVideoFocusBtn: true,
        },
        local: {
            showVideoPipBtn: true,
            showSnapShotBtn: true,
            showVideoCircleBtn: true,
            showZoomInOutBtn: false,
            showVideoFocusBtn: true,
        },
        whiteboard: {
            whiteboardLockBtn: false,
        },
    },
    // ==========================================
    // Webhook
    // ==========================================
    webhook: {
        enabled: false,
        url: 'http://localhost:8888/webhook-endpoint',
    },
};
