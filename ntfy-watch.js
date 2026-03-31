'use strict';

const http  = require('http');
const https = require('https');

const {
    applyAuth,
    parseUrl
} = require('./helpers');

/**
 * ntfy-watch
 *
 * Poll an ntfy topic on a fixed interval. Only emits messages that arrived
 * after the node started — tracks the last seen message ID and uses ntfy's
 * poll API to fetch only new messages each interval.
 *
 * More reliable than a persistent stream connection in Node.js and guarantees
 * no missed messages as long as messages remain in ntfy's cache (default 12
 * hours on self-hosted instances).
 *
 * Output message properties:
 *   msg.payload         {string}      - notification body
 *   msg.ntfyTopic       {string}      - topic the message arrived on
 *   msg.ntfyTitle       {string}      - title (empty string if not set)
 *   msg.ntfyPriority    {number}      - 1-5 (default 3)
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
 *   msg.payload = "stop"   - stop polling
 *   msg.payload = "start"  - resume polling (continues from last seen message ID)
 *   msg.payload = "reset"  - reset watermark to now and resume polling
 *   msg.ntfyOptions        - change topic/filters, resets watermark and resumes
 */
module.exports = function (RED) {

    function NtfyWatchNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.serverConfig = RED.nodes.getNode(config.server);
        node.topic        = config.topic        || '';
        node.interval     = parseInt(config.interval) || 30;
        node.filterMsg    = config.filterMsg    || '';
        node.filterTitle  = config.filterTitle  || '';
        node.filterPrio   = config.filterPrio   || '';
        node.filterTags   = config.filterTags   || '';

        // Internal state
        node._active    = false;
        node._pollTimer = null;
        node._lastId    = null;   // ID of last emitted message — used as since= watermark
        node._lastTime  = null;   // Unix timestamp watermark used on first poll

        if (!node.serverConfig) {
            node.error('ntfy-watch: no server configured');
            node.status({ fill: 'red', shape: 'ring', text: 'no server' });
            return;
        }

        // ------------------------------------------------------------------
        // poll - fetch new messages since last seen ID
        // ------------------------------------------------------------------
        function poll(opts) {
            const topic = opts.topic;
            if (!topic) {
                node.status({ fill: 'red', shape: 'ring', text: 'no topic' });
                return;
            }

            const qs = new URLSearchParams();

            // poll=1 makes ntfy return cached messages and close the connection
            qs.set('poll', '1');

            // Use last seen message ID as the watermark if we have one,
            // otherwise fall back to a Unix timestamp watermark
            if (node._lastId) {
                qs.set('since', node._lastId);
            } else if (node._lastTime) {
                qs.set('since', String(node._lastTime));
            } else {
                // First poll — set watermark to now so we only get future messages
                node._lastTime = Math.floor(Date.now() / 1000);
                qs.set('since', String(node._lastTime));
            }

            // Server-side filters
            if (opts.filterMsg)   qs.set('message',  opts.filterMsg);
            if (opts.filterTitle) qs.set('title',    opts.filterTitle);
            if (opts.filterPrio)  qs.set('priority', opts.filterPrio);
            if (opts.filterTags)  qs.set('tags',     opts.filterTags);

            const topicPath = topic.split(',').map(t => t.trim()).join(',');
            const rawUrl    = `${node.serverConfig.server}/${topicPath}/json?${qs.toString()}`;
            const parsed    = parseUrl(rawUrl);

            if (!parsed) {
                node.status({ fill: 'red', shape: 'ring', text: 'invalid URL' });
                return;
            }

            const headers = {};
            applyAuth(headers, node.serverConfig);

            const isHttps   = parsed.protocol === 'https:';
            const transport = isHttps ? https : http;

            const reqOpts = {
                method:   'GET',
                hostname: parsed.hostname,
                port:     parsed.port,
                path:     parsed.path,
                headers
            };

            const req = transport.request(reqOpts, (res) => {
                if (res.statusCode === 401 || res.statusCode === 403) {
                    node.status({ fill: 'red', shape: 'dot', text: 'auth error' });
                    node.error(`ntfy-watch: authentication failed (HTTP ${res.statusCode})`);
                    node._active = false;
                    return;
                }

                if (res.statusCode !== 200) {
                    node.status({ fill: 'red', shape: 'dot', text: `HTTP ${res.statusCode}` });
                    // Don't stop polling on server errors — server may recover
                    schedulePoll(opts);
                    return;
                }

                // Collect the full response — poll=1 closes after sending all messages
                let body = '';
                res.on('data', chunk => { body += chunk.toString(); });
                res.on('end', () => {
                    const lines    = body.split('\n').filter(l => l.trim());
                    const messages = [];

                    lines.forEach(line => {
                        try {
                            const event = JSON.parse(line);
                            if (event.event === 'message') messages.push(event);
                        } catch (e) {
                            // skip unparseable lines
                        }
                    });

                    // Sort oldest-first so we emit in chronological order
                    messages.sort((a, b) => a.time - b.time);

                    if (messages.length > 0) {
                        node.status({
                            fill:  'green',
                            shape: 'dot',
                            text:  `${messages.length} msg${messages.length > 1 ? 's' : ''}`
                        });

                        messages.forEach(event => {
                            // Advance the watermark to this message's ID
                            node._lastId = event.id;

                            node.send({
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
                            });
                        });
                    } else {
                        node.status({
                            fill:  'green',
                            shape: 'ring',
                            text:  `watching ${topic}`
                        });
                    }

                    schedulePoll(opts);
                });

                res.on('error', (err) => {
                    node.error(`ntfy-watch poll error: ${err.message}`);
                    schedulePoll(opts);
                });
            });

            req.on('error', (err) => {
                node.status({ fill: 'red', shape: 'dot', text: 'poll error' });
                node.error(`ntfy-watch: ${err.message}`);
                schedulePoll(opts);
            });

            req.end();
        }

        // ------------------------------------------------------------------
        // schedulePoll - queue the next poll after the interval
        // ------------------------------------------------------------------
        function schedulePoll(opts) {
            if (!node._active) return;
            node._pollTimer = setTimeout(() => {
                if (node._active) poll(opts);
            }, node.interval * 1000);
        }

        // ------------------------------------------------------------------
        // start - begin polling with given options
        // ------------------------------------------------------------------
        function start(overrides) {
            clearPollTimer();
            node._active = true;

            const opts = Object.assign({
                topic:       node.topic,
                filterMsg:   node.filterMsg,
                filterTitle: node.filterTitle,
                filterPrio:  node.filterPrio,
                filterTags:  node.filterTags
            }, overrides || {});

            node.status({ fill: 'green', shape: 'ring', text: `watching ${opts.topic}` });
            poll(opts);
        }

        // ------------------------------------------------------------------
        // stop - halt polling
        // ------------------------------------------------------------------
        function stop() {
            node._active = false;
            clearPollTimer();
            node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
        }

        function clearPollTimer() {
            if (node._pollTimer) {
                clearTimeout(node._pollTimer);
                node._pollTimer = null;
            }
        }

        // ------------------------------------------------------------------
        // Input message handler - runtime control
        // ------------------------------------------------------------------
        node.on('input', function (msg) {
            if (msg.payload === 'stop') {
                stop();
                return;
            }
            if (msg.payload === 'reset') {
                node._lastId   = null;
                node._lastTime = null;
                start(msg.ntfyOptions || {});
                return;
            }
            if (msg.payload === 'start') {
                if (!node._active) start(msg.ntfyOptions || {});
                return;
            }
            // ntfyOptions on the message — change topic/filters, reset watermark, restart
            if (msg.ntfyOptions) {
                node._lastId   = null;
                node._lastTime = null;
                stop();
                start(msg.ntfyOptions);
            }
        });

        // ------------------------------------------------------------------
        // Cleanup on node removal or redeploy
        // ------------------------------------------------------------------
        node.on('close', function (done) {
            stop();
            done();
        });

        // Start polling on deploy
        start();
    }

    RED.nodes.registerType('ntfy-watch', NtfyWatchNode);

};