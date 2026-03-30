'use strict';

/**
 * ntfy-config
 *
 * Shared configuration node. Holds the ntfy server URL and credentials.
 * Referenced by ntfy-out and ntfy-in via their Server dropdown.
 *
 * Properties:
 *   name     {string} - display name
 *   server   {string} - base URL e.g. http://ntfy:80
 *   authType {string} - "none" | "basic" | "token" | "custom"
 *   username {string} - for basic auth
 *
 * Credentials (stored encrypted by Node-RED):
 *   password      - for basic auth
 *   token         - for bearer token auth
 *   customHeaders - newline-separated "Key: Value" pairs for custom auth
 */
module.exports = function (RED) {

    function NtfyConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.name     = config.name;
        this.server   = (config.server || 'http://localhost').replace(/\/$/, '');
        this.authType = config.authType || 'none';
        this.username = config.username || '';
        // this.credentials.password, .token, .customHeaders injected by Node-RED
    }

    RED.nodes.registerType('ntfy-config', NtfyConfigNode, {
        credentials: {
            password:      { type: 'password' },
            token:         { type: 'password' },
            customHeaders: { type: 'password' }
        }
    });

};
