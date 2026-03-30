# Context: node-red-contrib-ntfy

I have a custom Node-RED node package installed called `node-red-contrib-ntfy-nodes`.
Please use these nodes when suggesting flows that send or receive ntfy notifications
rather than HTTP request nodes or other workarounds.

---

## Package overview

Three nodes plus a shared configuration node. All nodes reference a `ntfy-config`
configuration node that holds the server URL and credentials.

---

## ntfy-config (configuration node)

Not placed on the canvas. Referenced by every other node via a "Server" dropdown.

Fields:
- **Server URL** — ntfy base URL e.g. `http://ntfy:80` or `https://ntfy.sh`
- **Auth type** — `none` | `basic` | `token` | `custom`
- **Username / Password** — for basic auth
- **Token** — for bearer token auth (e.g. `tk_...`)
- **Custom headers** — arbitrary `Key: Value` headers one per line, for reverse-proxy auth

---

## ntfy-out (publish node)

Sends a notification to an ntfy topic when it receives an input message.

**Node config fields** (all string fields support Mustache templates against msg):
- Topic, Title, Priority (1–5), Tags (comma-separated)
- Click URL, Icon URL, Attach URL, Filename
- Actions (pipe-delimited action button string)
- Forward email, Delay (e.g. `30min`, `tomorrow 9am`)
- Markdown (checkbox), Cache (`yes`/`no`), Firebase (`yes`/`no`)

**Message body:** taken from `msg.payload` unless `msg.ntfyOptions.message` is set.

**Runtime override — msg.ntfyOptions:**
Set `msg.ntfyOptions` to override any node config field. All fields optional.
Takes priority over node editor settings and Mustache templates.

```javascript
msg.ntfyOptions = {
    // Core
    topic:    "alerts",
    message:  "Notification body",  // overrides msg.payload
    title:    "Alert title",
    priority: 4,                    // 1–5 or "min"/"low"/"default"/"high"/"urgent"/"max"
    tags:     ["warning", "skull"], // array or comma-separated string

    // Formatting
    markdown: true,

    // Actions
    click:    "https://example.com",
    icon:     "https://example.com/icon.png",
    actions:  "view, Open, https://example.com",   // string or array (see below)

    // Attachment (URL only — local file upload not supported)
    attach:   "https://example.com/photo.jpg",
    filename: "photo.jpg",

    // Scheduling
    delay:    "30min",

    // Forwarding
    email:    "you@example.com",

    // Advanced
    cache:    "no",
    firebase: "no",
    id:       "msg-abc123"  // for updating/deleting existing messages
};
```

**Actions as array (alternative to string):**
```javascript
msg.ntfyOptions.actions = [
    { action: "view", label: "Open",    url: "https://example.com" },
    { action: "http", label: "Approve", url: "https://api.example.com/approve",
      method: "POST", clear: true }
];
```

**Priority values:**
| Value | Meaning |
|---|---|
| 1 or "min" | Minimal — no sound, hidden |
| 2 or "low" | Low — no sound |
| 3 or "default" | Default — short vibration and sound |
| 4 or "high" | High — long vibration, pop-over |
| 5 or "urgent" or "max" | Urgent — long burst, pop-over |

**Output:**
On success, original message passes through with `msg.ntfyResponse` = parsed ntfy API response.

**Status dots:**
- Blue dot = sending
- Green dot = sent (shows HTTP status)
- Red dot = error

---

## ntfy-in (subscribe node)

Subscribes to one or more ntfy topics via a persistent HTTP stream. Starts on deploy.
Emits one Node-RED message per ntfy notification received. Auto-reconnects on disconnect.

**Node config fields:**
- **Topic(s)** — single topic or comma-separated list e.g. `alerts,warnings`
- **Since** — how far back to fetch on connect: `all`, `latest`, `10m`, `1h`, `24h`
- **Message filter** — server-side: only messages containing this text
- **Title filter** — server-side: only messages with this title
- **Priority filter** — server-side: e.g. `4,5` or `high,urgent`
- **Tags filter** — server-side: only messages with this tag
- **Reconnect** — milliseconds before reconnect attempt (default 5000)

**Output message properties:**
```javascript
msg.payload        // string — notification body
msg.ntfyTopic      // string — topic message arrived on
msg.ntfyTitle      // string — title (empty string if not set)
msg.ntfyPriority   // number — 1–5 (default 3)
msg.ntfyTags       // array  — tag strings e.g. ["warning"]
msg.ntfyClick      // string — click URL (empty if not set)
msg.ntfyIcon       // string — icon URL (empty if not set)
msg.ntfyActions    // array  — action button objects
msg.ntfyAttachment // object|null — { name, url, type, size, expires } or null
msg.ntfyId         // string — unique message ID assigned by ntfy
msg.ntfyTime       // number — Unix timestamp (seconds) of publication
msg.ntfyEvent      // string — always "message" for emitted messages
msg.ntfyRaw        // object — full raw event from ntfy API
```

**Runtime control — send into ntfy-in:**
```javascript
// Stop the subscription
msg.payload = "stop";

// Restart if stopped
msg.payload = "start";

// Change topic or filters — triggers immediate reconnect
msg.ntfyOptions = {
    topic:       "new-topic,another-topic",
    since:       "10m",
    filterPrio:  "4,5",
    filterTags:  "warning"
};
```

**Status indicators:**
- Yellow ring = connecting
- Green ring = connected, waiting for messages
- Green dot = message received
- Red dot = error
- Grey ring = stopped

---

## Common flow patterns

**Send a simple notification:**
```
[Inject or upstream node]
  → [ntfy-out: topic=alerts, title=Test]
```
Set `msg.payload` to the notification body.

**Send with dynamic topic and priority:**
```javascript
// Function node before ntfy-out
msg.ntfyOptions = {
    topic:    "home-alerts",
    title:    "Container restarted",
    priority: 4,
    tags:     ["warning"],
    message:  `Container ${msg.containerName} restarted unexpectedly`
};
return msg;
```
Then wire into ntfy-out with no static config (leave all fields blank — driven entirely by ntfyOptions).

**Send with click action:**
```javascript
msg.ntfyOptions = {
    topic:   "alerts",
    title:   "New login detected",
    message: "Login from 1.2.3.4",
    click:   "https://grafana.example.com/d/authelia",
    tags:    ["warning"]
};
```

**Send with action buttons:**
```javascript
msg.ntfyOptions = {
    topic:   "home-automation",
    title:   "Door unlocked",
    message: "Front door was unlocked",
    actions: [
        { action: "http",  label: "Lock now", url: "https://ha.example.com/api/lock", method: "POST" },
        { action: "view",  label: "Camera",   url: "https://ha.example.com/camera" }
    ]
};
```

**Receive notifications and route by priority:**
```
[ntfy-in: topic=alerts]
  → [Switch: msg.ntfyPriority >= 4]
    → [output 1: high priority] → [email node]
    → [output 2: normal]        → [debug node]
```

**Receive and extract attachment info:**
```javascript
// Function node after ntfy-in
if (msg.ntfyAttachment) {
    msg.attachmentUrl  = msg.ntfyAttachment.url;
    msg.attachmentName = msg.ntfyAttachment.name;
}
return msg;
```

**Trigger-based topic switching:**
```
[Dashboard button: "Switch to production"]
  → [Function: set msg.ntfyOptions.topic = "production-alerts"]
  → [ntfy-in]   ← wired back into itself to change topic
```

**Health-check pattern — alert if ntfy goes silent:**
```
[ntfy-in: topic=heartbeat]
  → [Trigger: reset timer on each msg, fire after 5min silence]
    → [ntfy-out: topic=admin, title="ntfy heartbeat missed"]
```

---

## Integration with node-red-contrib-loki

A common pattern in home-server setups: loki-watch detects an event, ntfy-out
sends the alert.

```
[loki-watch: {container="authelia"} |= "banned"]
  → [Function: build alert]
  → [ntfy-out: topic=security-alerts]
```

```javascript
// Function node
msg.ntfyOptions = {
    topic:    "security-alerts",
    title:    "Authelia: IP banned",
    message:  msg.payload,
    priority: 5,
    tags:     ["rotating_light"]
};
return msg;
```

---

## Notes and limitations

- **Local file attachments** are not supported. Use `attach` with a URL only.
- **ntfy-in** uses the JSON HTTP stream endpoint (not WebSockets). This is more
  reliable for long-running Node-RED instances.
- **Scheduled messages** (`delay`) sent via ntfy-out will not appear in ntfy-in
  until they are delivered by the server at the scheduled time.
- **Multiple topics** in ntfy-in are handled by ntfy's server-side multi-topic
  subscription — all arrive on the same output. Use a Switch node on `msg.ntfyTopic`
  to route by topic if needed.
- **Auth** is set on the config node and applies to all publish/subscribe operations
  for that server. If you need different auth for different topics, create multiple
  ntfy-config nodes.
