'use strict';

const http  = require('http');
const https = require('https');

const {
    applyAuth,
    parseUrl
} = require('./helpers');

/**
 * ntfy-in
 *
 * Subscribe to one or more ntfy topics via a persistent JSON HTTP stream.
 * Emits one Node-RED message per ntfy notification received.
 * Starts automatically on deploy and reconnects if the connection drops.
 *
 * Output message properties:
 *   msg.payload         {string}      - notification body
 *   msg.ntfyTopic       {string}      - topic the message arrived on
 *   msg.ntfyTitle       {string}      - title (empty string if not set)
 *   msg.ntfyPriority    {number}      - 1–5 (default 3)
 *   msg.ntfyTags        {string[]}    - tag strings
 *   msg.ntfyClick       {string}      - click URL (empty string if not set)
 *   msg.ntfyIcon        {string}      - icon URL (empty string if not set)
 *   msg.ntfyActions     {object[]}    - action button objects
 *   msg.ntfyAttachment  {object|null} - attachment details or null
 *   msg.ntfyId          {string}      - unique message ID
 *   msg.ntfyTime        {number}      - Unix timestamp (seconds)
 *   msg.ntfyEvent       {string}      - always "message"
 *   msg.ntfyRaw         {object}      - full raw event from ntfy API
 *
 * Runtime control via input message:
 *   msg.payload = "stop"   - disconnect and stop reconnecting
 *   msg.payload = "start"  - reconnect if stopped
 *   msg.ntfyOptions        - change topic/filters and reconnect immediately
 */
module.exports = function (RED) {

    function NtfyInNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Config node reference
        node.serverConfig = RED.nodes.getNode(config.server);

        // Node editor fields
        node.topic       = config.topic       || '';
        node.since       = config.since       || 'all';
        node.filterMsg   = config.filterMsg   || '';
        node.filterTitle = config.filterTitle || '';
        node.filterPrio  = config.filterPrio  || '';
        node.filterTags  = config.filterTags  || '';
        node.reconnectMs = parseInt(config.reconnectMs) || 5000;

        // Internal state
        node._active      = false;
        node._req         = null;
        node._reconnTimer = null;

        if (!node.serverConfig) {
            node.error('ntfy-in: no server configured');
            node.status({ fill: 'red', shape: 'ring', text: 'no server' });
            return;
        }

        // ------------------------------------------------------------------
        // connect — open the streaming subscription
        // ------------------------------------------------------------------
        function connect(overrides) {
            clearReconnectTimer();

            // Merge any runtime overrides over node config defaults
            const opts = Object.assign({
                topic:       node.topic,
                since:       node.since,
                filterMsg:   node.filterMsg,
                filterTitle: node.filterTitle,
                filterPrio:  node.filterPrio,
                filterTags:  node.filterTags
            }, overrides || {});

            const topic = opts.topic;
            if (!topic) {
                node.status({ fill: 'red', shape: 'ring', text: 'no topic' });
                return;
            }

            // Build query string — ntfy supports comma-separated multi-topic
            const qs = new URLSearchParams();
            if (opts.since)       qs.set('since',    opts.since);
            if (opts.filterMsg)   qs.set('message',  opts.filterMsg);
            if (opts.filterTitle) qs.set('title',    opts.filterTitle);
            if (opts.filterPrio)  qs.set('priority', opts.filterPrio);
            if (opts.filterTags)  qs.set('tags',     opts.filterTags);

            const topicPath = topic.split(',').map(t => t.trim()).join(',');
            const rawUrl    = `${node.serverConfig.server}/${topicPath}/json?${qs.toString()}`;
            const parsed    = parseUrl(rawUrl);

            if (!parsed) {
                node.status({ fill: 'red', shape: 'ring', text: 'invalid URL' });
                node.error(`ntfy-in: invalid server URL: ${node.serverConfig.server}`);
                return;
            }

            // Build request headers
            const headers = {};
            applyAuth(headers, node.serverConfig);

            const reqOpts = {
                method:   'GET',
                hostname: parsed.hostname,
                port:     parsed.port,
                path:     parsed.path,
                headers
            };

            node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
            node._active = true;

            const transport = parsed.protocol === 'https:' ? https : http;

            const req = transport.request(reqOpts, (res) => {
                // Handle auth errors — do not reconnect
                if (res.statusCode === 401 || res.statusCode === 403) {
                    node.status({ fill: 'red', shape: 'dot', text: 'auth error' });
                    node.error(`ntfy-in: authentication failed (HTTP ${res.statusCode})`);
                    node._active = false;
                    return;
                }

                if (res.statusCode !== 200) {
                    node.status({ fill: 'red', shape: 'dot', text: `HTTP ${res.statusCode}` });
                    scheduleReconnect(overrides);
                    return;
                }

                node.status({ fill: 'green', shape: 'ring', text: `watching ${topic}` });

                let buffer = '';

                res.on('data', (chunk) => {
                    buffer += chunk.toString();

                    // ntfy sends one JSON object per line
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // keep any incomplete trailing line

                    lines.forEach(line => {
                        line = line.trim();
                        if (!line) return;
                        processLine(line);
                    });
                });

                res.on('end', () => {
                    if (node._active) {
                        node.status({ fill: 'yellow', shape: 'ring', text: 'reconnecting' });
                        scheduleReconnect(overrides);
                    }
                });

                res.on('error', (err) => {
                    node.error(`ntfy-in stream error: ${err.message}`);
                    if (node._active) scheduleReconnect(overrides);
                });
            });

            req.on('error', (err) => {
                node.status({ fill: 'red', shape: 'dot', text: 'connection error' });
                node.error(`ntfy-in: ${err.message}`);
                if (node._active) scheduleReconnect(overrides);
            });

            req.end();
            node._req = req;
        }

        // ------------------------------------------------------------------
        // processLine — parse a single JSON line from the stream
        // ------------------------------------------------------------------
        function processLine(line) {
            let event;
            try {
                event = JSON.parse(line);
            } catch (e) {
                return; // skip unparseable lines
            }

            // ntfy sends "open" and "keepalive" events — only emit "message"
            if (event.event !== 'message') return;

            node.status({ fill: 'green', shape: 'dot', text: `msg on ${event.topic}` });

            const msg = {
                payload:        event.message     || '',
                ntfyEvent:      event.event,
                ntfyTopic:      event.topic        || '',
                ntfyId:         event.id           || '',
                ntfyTime:       event.time         || 0,
                ntfyTitle:      event.title        || '',
                ntfyPriority:   event.priority     || 3,
                ntfyTags:       event.tags         || [],
                ntfyClick:      event.click        || '',
                ntfyIcon:       event.icon         || '',
                ntfyActions:    event.actions      || [],
                ntfyAttachment: event.attachment   || null,
                ntfyRaw:        event
            };

            node.send(msg);
        }

        // ------------------------------------------------------------------
        // disconnect — cleanly stop the connection and cancel reconnect timer
        // ------------------------------------------------------------------
        function disconnect() {
            node._active = false;
            clearReconnectTimer();
            if (node._req) {
                node._req.destroy();
                node._req = null;
            }
            node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
        }

        // ------------------------------------------------------------------
        // scheduleReconnect — wait reconnectMs then call connect again
        // ------------------------------------------------------------------
        function scheduleReconnect(overrides) {
            if (!node._active) return;
            node.status({ fill: 'yellow', shape: 'ring', text: 'reconnecting...' });
            node._reconnTimer = setTimeout(() => {
                if (node._active) connect(overrides);
            }, node.reconnectMs);
        }

        function clearReconnectTimer() {
            if (node._reconnTimer) {
                clearTimeout(node._reconnTimer);
                node._reconnTimer = null;
            }
        }

        // ------------------------------------------------------------------
        // Input message handler — runtime control
        // ------------------------------------------------------------------
        node.on('input', function (msg) {
            if (msg.payload === 'stop') {
                disconnect();
                return;
            }
            if (msg.payload === 'start') {
                if (!node._active) connect(msg.ntfyOptions || {});
                return;
            }
            // ntfyOptions on the message — change topic/filters and reconnect
            if (msg.ntfyOptions) {
                disconnect();
                node._active = true;
                connect(msg.ntfyOptions);
            }
        });

        // ------------------------------------------------------------------
        // Cleanup on node removal or redeploy
        // ------------------------------------------------------------------
        node.on('close', function (done) {
            disconnect();
            done();
        });

        // Start on deploy
        connect();
    }

    RED.nodes.registerType('ntfy-in', NtfyInNode);

};
