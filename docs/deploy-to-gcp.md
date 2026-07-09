# Deploy to GCP VM

The generative fallback code is committed but needs to be deployed to the GCP VM.

## Quick Deploy (Recommended)

1. SSH into the VM:
```bash
ssh ubuntu@35.208.20.1
```

2. Pull the latest code:
```bash
cd /opt/recruiter-chat-api
git pull origin master
```

3. Restart the service:
```bash
sudo systemctl restart recruiter-chat-api
# or if using pm2:
pm2 restart recruiter-chat-api
```

4. Verify it's working:
```bash
curl -X POST https://projecthub-chat.bradleymatera.dev/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "what\u0027s brads favorite food?", "options": {"flavorEnabled": false}}'
```

Expected response should contain a coherent message like:
> "I do not have Bradley's favorite food verified..."

## Alternative: Copy File Directly

From your local machine in the ProjectHub repo:
```bash
scp server-gcp.js ubuntu@35.208.20.1:/opt/recruiter-chat-api/
ssh ubuntu@35.208.20.1 "sudo systemctl restart recruiter-chat-api"
```

## Using the Deploy Script

```bash
./deploy-gcp.sh
```

The script will:
1. Check syntax locally
2. Copy `server-gcp.js` to the VM
3. Backup the old file
4. Restart the service

## Troubleshooting

If the service doesn't restart:
```bash
ssh ubuntu@35.208.20.1
sudo systemctl status recruiter-chat-api
sudo journalctl -u recruiter-chat-api -n 50
```

If the API still returns old responses:
1. Check the file was actually updated:
   ```bash
   ssh ubuntu@35.208.20.1 "grep 'buildConversationalUnknownPrompt' /opt/recruiter-chat-api/server-gcp.js"
   ```
2. If not found, the deploy didn't work. Try manual copy.
3. If found but still old behavior, restart Ollama:
   ```bash
   ssh ubuntu@35.208.20.1 "sudo systemctl restart ollama"
   ```
