# backend-guide.md

**Read when:** You need to deploy, migrate, or secure the zero-cost Ollama chat backend on Google Cloud.

---

## Goal

Host an Ollama-backed chat API that serves the ProjectHub widget from a free Google Cloud micro VM, replacing the current Heroku proxy.

---

## Always Free Constraints

| Resource | Allowance |
|----------|-----------|
| Compute Engine | 1 `f1-micro` or 1 `e2-micro` instance, up to 720 hours/month |
| Regions | `us-west1`, `us-central1`, `us-east1` |
| Disk | 30 GB standard persistent disk |
| Snapshot | 5 GB |
| Firestore | 1 GiB storage, 50k reads/day, 20k writes/day, 20k deletes/day |
| Same-region egress | Free |

Use an `e2-micro` with standard persistent disk to stay within Always Free.

---

## Architecture

```mermaid
flowchart LR
    A[ProjectHub widget] -- HTTPS POST /api/chat --> B[Proxy on GCP VM port 8080]
    B -- HTTP --> C[Ollama localhost:11434]
    B -- optional --> D[Firestore Native mode]
```

---

## Step-by-Step Deployment

### 1. Create the VM

- Region: `us-west1`, `us-central1`, or `us-east1`
- Machine type: `e2-micro`
- Boot disk: Ubuntu 22.04 LTS, 30 GB standard persistent disk
- Allow HTTP/HTTPS traffic (we will narrow this later)

### 2. Install Ollama

SSH into the VM and run:

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
```

Ollama will listen on `localhost:11434`.

### 3. Pull a Lightweight Model

Choose a model that fits ~1 GiB RAM on an `e2-micro`. Examples:

```bash
ollama pull mistral:7b-instruct-q4_K_M
ollama pull phi3:mini
ollama pull llama3.2:1b
```

Avoid large models like `gpt-oss:20b`; they will not run on micro hardware.

### 4. Build the Proxy Server

A minimal Node.js/Express proxy:

```javascript
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const app = express();

const ALLOWED_ORIGINS = ['https://bradleymatera.github.io'];
const API_KEY = process.env.PROJECTHUB_API_KEY;

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());

app.post('/api/chat', async (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ollamaRes = await fetch('http://localhost:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mistral:7b-instruct-q4_K_M',
      messages: [{ role: 'user', content: req.body.message }]
    })
  });

  const data = await ollamaRes.json();
  res.json({ reply: data.choices?.[0]?.message?.content || 'No response' });
});

app.listen(8080, () => console.log('Proxy listening on port 8080'));
```

### 5. Run the Proxy as a Service

Use `systemd` or `pm2` so the proxy starts on boot and restarts on failure.

Example `systemd` service at `/etc/systemd/system/projecthub-proxy.service`:

```ini
[Unit]
Description=ProjectHub Ollama Proxy
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/projecthub-proxy
ExecStart=/usr/bin/node server.js
Environment=PROJECTHUB_API_KEY=your-secret-key
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now projecthub-proxy
```

### 6. Secure the Network

- Create a firewall rule allowing inbound TCP 8080 only from your website’s IP ranges or CDN ranges (e.g., GitHub Pages IPs).
- Block direct access to port 11434 from the internet.
- Do not expose the Ollama port publicly.

### 7. HTTPS

Options:

- **Google Cloud managed certificate** with HTTPS Load Balancer (free tier includes first 5 forwarding rules; keep an eye on costs).
- **Self-hosted Let’s Encrypt** using `certbot` on the VM.

For zero cost, Let’s Encrypt on the VM is simplest:

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d chat.recruiterhub.yourdomain.com
```

Update the Node proxy to use the generated certificate and listen on 443.

### 8. Static IP and DNS

- Reserve a regional static external IP and attach it to the VM (free while attached to a running VM).
- Create an A record `chat.recruiterhub.yourdomain.com` pointing to the static IP.
- Update the widget fallback URL in `logic.js` to `https://chat.recruiterhub.yourdomain.com/api/chat`.

### 9. Optional: Firestore Chat History

- Enable Firestore in Native mode.
- Use the Firebase Admin SDK in the proxy to write messages to a `messages` collection.
- Stay under the free daily quotas.

### 10. Frontend Integration

In `logic.js`, replace the fallback URL:

```javascript
const res = await fetch("https://chat.recruiterhub.yourdomain.com/api/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "your-public-or-client-key"
  },
  body: JSON.stringify({ message: userQuery })
});
```

> Note: embedding an API key in client-side JS is not fully secure. Combine it with origin/CORS restrictions and rotate it regularly.

---

## Monitoring

- Watch CPU and memory in the Google Cloud console.
- If the model is too heavy, switch to a smaller quantization (`Q3_K_M`) or a smaller model.
- Keep traffic within the same region to avoid egress charges.
- Rotate API keys periodically.

---

## Cost Checklist

- [ ] `e2-micro` in an Always Free region
- [ ] 30 GB standard persistent disk
- [ ] Static regional IP attached to running VM
- [ ] Same-region traffic only
- [ ] Firestore within daily free quotas
- [ ] HTTPS certificate free (Let’s Encrypt or managed cert that fits free tier)
