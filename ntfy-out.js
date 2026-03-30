'use strict';

const http  = require('http');
const https = require('https');

const {
    applyAuth,
    render,
    mergeOptions,
    parseUrl,
    normalisePriority
} = require('./helpers');

/**
 * ntfy-out
 *
 * Publish a notification to an ntfy topic when a message is received.
 *
 * Message body is taken from msg.payload unless msg.ntfyOptions.message is set.
 * All string node config fields support Mustache templates resolved against msg.
 * Any field can be overridden at runtime via msg.ntfyOptions.
 *
 * On success the original message passes through with msg.ntfyResponse set to
 * the parsed JSON response from the ntfy server.
 */
module.exports = function (RED) {

    function NtfyOutNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Config node reference
        node.serverConfig = RED.nodes.getNode(config.server);

        // Node editor field values — used as defaults, all support Mustache
        node.topic    = config.topic    || '';
        node.title    = config.title    || '';
        node.priority = config.priority || '';
        node.tags     = config.tags     || '';
        node.click    = config.click    || '';
        node.icon     = config.icon     || '';
        node.attach   = config.attach   || '';
        node.filename = config.filename || '';
        node.actions  = config.actions  || '';
        node.email    = config.email    || '';
        node.delay    = config.delay    || '';
        node.markdown = config.markdown || false;
        node.cache    = config.cache    || '';
        node.firebase = config.firebase || '';

        if (!node.serverConfig) {
            node.error('ntfy-out: no server configured');
            node.status({ fill: 'red', shape: 'ring', text: 'no server' });
            return;
        }

        node.on('input', function (msg, send, done) {

            // ------------------------------------------------------------------
            // 1. Build node-level defaults by rendering Mustache templates
            // ------------------------------------------------------------------
            const defaults = {
                topic:    render(node.topic,    msg),
                title:    render(node.title,    msg),
                priority: render(node.priority, msg),
                tags:     render(node.tags,     msg),
                click:    render(node.click,    msg),
                icon:     render(node.icon,     msg),
                attach:   render(node.attach,   msg),
                filename: render(node.filename, msg),
                actions:  render(node.actions,  msg),
                email:    render(node.email,    msg),
                delay:    render(node.delay,    msg),
                markdown: node.markdown,
                cache:    node.cache,
                firebase: node.firebase
            };

            // ------------------------------------------------------------------
            // 2. Merge msg.ntfyOptions over defaults (options always win)
            // ------------------------------------------------------------------
            const opts = mergeOptions(defaults, msg);

            // Topic is required
            if (!opts.topic) {
                done(new Error('ntfy-out: no topic specified (set in node config or msg.ntfyOptions.topic)'));
                return;
            }

            // ------------------------------------------------------------------
            // 3. Determine message body
            // ------------------------------------------------------------------
            const body = (opts.message !== undefined)
                ? String(opts.message)
                : (msg.payload !== undefined ? String(msg.payload) : '');

            // ------------------------------------------------------------------
            // 4. Build HTTP request headers
            // ------------------------------------------------------------------
            const headers = {};

            if (opts.title)    headers['Title']    = opts.title;
            if (opts.click)    headers['Click']    = opts.click;
            if (opts.icon)     headers['Icon']     = opts.icon;
            if (opts.attach)   headers['Attach']   = opts.attach;
            if (opts.filename) headers['Filename'] = opts.filename;
            if (opts.email)    headers['Email']    = opts.email;
            if (opts.delay)    headers['Delay']    = opts.delay;
            if (opts.cache)    headers['Cache']    = opts.cache;
            if (opts.firebase) headers['Firebase'] = opts.firebase;
            if (opts.markdown) headers['Markdown'] = 'yes';

            // Message ID (for updates/deletes)
            if (opts.id) headers['X-ID'] = opts.id;

            // Priority — normalise to integer
            const priority = normalisePriority(opts.priority);
            if (priority !== undefined) headers['Priority'] = String(priority);

            // Tags — accept array or comma-separated string
            if (opts.tags) {
                const tagStr = Array.isArray(opts.tags)
                    ? opts.tags.join(',')
                    : String(opts.tags);
                if (tagStr) headers['Tags'] = tagStr;
            }

            // Actions — accept array (serialised to JSON) or raw string
            if (opts.actions) {
                headers['Actions'] = (typeof opts.actions === 'object')
                    ? JSON.stringify(opts.actions)
                    : String(opts.actions);
            }

            // Auth headers
            applyAuth(headers, node.serverConfig);

            headers['Content-Type']   = 'text/plain; charset=utf-8';
            headers['Content-Length'] = Buffer.byteLength(body);

            // ------------------------------------------------------------------
            // 5. Build request options
            // ------------------------------------------------------------------
            const serverUrl = parseUrl(`${node.serverConfig.server}/${opts.topic}`);
            if (!serverUrl) {
                done(new Error(`ntfy-out: invalid server URL: ${node.serverConfig.server}`));
                return;
            }

            const reqOpts = {
                method:   'POST',
                hostname: serverUrl.hostname,
                port:     serverUrl.port,
                path:     serverUrl.path,
                headers
            };

            // ------------------------------------------------------------------
            // 6. Send request
            // ------------------------------------------------------------------
            const transport = serverUrl.protocol === 'https:' ? https : http;

            node.status({ fill: 'blue', shape: 'dot', text: 'sending' });

            const req = transport.request(reqOpts, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        node.status({
                            fill:  'green',
                            shape: 'dot',
                            text:  `sent ${res.statusCode}`
                        });
                        try {
                            msg.ntfyResponse = JSON.parse(data);
                        } catch (e) {
                            msg.ntfyResponse = data;
                        }
                        send(msg);
                        done();
                    } else {
                        node.status({ fill: 'red', shape: 'dot', text: `error ${res.statusCode}` });
                        done(new Error(`ntfy server returned ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', (err) => {
                node.status({ fill: 'red', shape: 'dot', text: 'connection error' });
                done(err);
            });

            req.write(body);
            req.end();
        });

        node.on('close', function () {
            node.status({});
        });
    }

    RED.nodes.registerType('ntfy-out', NtfyOutNode);

};
