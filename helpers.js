'use strict';

const Mustache = require('mustache');

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Build the Authorization header value from a config node.
 * Returns null if no auth is configured.
 *
 * @param {object} config - ntfy-config node instance
 * @returns {string|null}
 */
function buildAuthHeader(config) {
    switch (config.authType) {
        case 'basic':
            return 'Basic ' + Buffer.from(
                `${config.username}:${config.credentials.password}`
            ).toString('base64');
        case 'token':
            return `Bearer ${config.credentials.token}`;
        default:
            return null;
    }
}

/**
 * Parse a custom headers string (one "Key: Value" per line) into an object.
 * Used for the "custom" auth type.
 *
 * @param {string} raw - multiline header string
 * @returns {object}
 */
function parseCustomHeaders(raw) {
    const result = {};
    if (!raw) return result;
    raw.split('\n').forEach(line => {
        const idx = line.indexOf(':');
        if (idx > 0) {
            const key   = line.slice(0, idx).trim();
            const value = line.slice(idx + 1).trim();
            if (key) result[key] = value;
        }
    });
    return result;
}

/**
 * Apply auth headers to a headers object in-place.
 * Handles all four auth types: none, basic, token, custom.
 *
 * @param {object} headers  - headers object to mutate
 * @param {object} config   - ntfy-config node instance
 */
function applyAuth(headers, config) {
    const auth = buildAuthHeader(config);
    if (auth) {
        headers['Authorization'] = auth;
        return;
    }
    if (config.authType === 'custom') {
        const custom = parseCustomHeaders(
            config.credentials && config.credentials.customHeaders
        );
        Object.assign(headers, custom);
    }
}

// ---------------------------------------------------------------------------
// Mustache rendering
// ---------------------------------------------------------------------------

/**
 * Render a string template through Mustache using the incoming msg as the view.
 * Falls back to the raw value if the template is not a string or rendering throws.
 *
 * @param {*}      template - template string (or any value)
 * @param {object} msg      - Node-RED message object used as Mustache view
 * @returns {*}
 */
function render(template, msg) {
    if (!template || typeof template !== 'string') return template;
    try {
        return Mustache.render(template, msg);
    } catch (e) {
        return template;
    }
}

// ---------------------------------------------------------------------------
// Options merging
// ---------------------------------------------------------------------------

/**
 * Merge msg.ntfyOptions over a set of node-level defaults.
 * msg.ntfyOptions always wins; node defaults are used for any key not present
 * in the override object.
 *
 * @param {object} defaults - node config defaults (already Mustache-rendered)
 * @param {object} msg      - incoming Node-RED message
 * @returns {object}
 */
function mergeOptions(defaults, msg) {
    const overrides = msg.ntfyOptions || {};
    return Object.assign({}, defaults, overrides);
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Parse a URL string into its component parts.
 * Returns null if the URL is invalid.
 *
 * @param {string} raw
 * @returns {{ protocol: string, hostname: string, port: number, path: string }|null}
 */
function parseUrl(raw) {
    try {
        const u = new URL(raw);
        return {
            protocol: u.protocol,
            hostname: u.hostname,
            port:     u.port
                ? parseInt(u.port)
                : (u.protocol === 'https:' ? 443 : 80),
            path:     u.pathname + u.search
        };
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Priority normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a priority value to an integer 1–5.
 * Accepts numeric strings, integers, and ntfy named priorities.
 * Returns undefined if the value is absent or unrecognisable.
 *
 * @param {string|number|undefined} p
 * @returns {number|undefined}
 */
function normalisePriority(p) {
    if (!p && p !== 0) return undefined;
    const map = {
        min:     1,
        low:     2,
        default: 3,
        high:    4,
        urgent:  5,
        max:     5
    };
    if (typeof p === 'string' && map[p.toLowerCase()] !== undefined) {
        return map[p.toLowerCase()];
    }
    const n = parseInt(p);
    return isNaN(n) ? undefined : Math.min(5, Math.max(1, n));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    buildAuthHeader,
    parseCustomHeaders,
    applyAuth,
    render,
    mergeOptions,
    parseUrl,
    normalisePriority
};
