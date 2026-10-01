# dsh-remote-access

Open the DSH web app from any browser outside your LAN, even when the machine has no public IP. Only DSH is published, behind a password (plus optional authenticator code). Dependency-free Node plugin; the tunnel is Tailscale Funnel (or, optionally, Windows' built-in OpenSSH).

```
browser --HTTPS (real certificate)--> Tailscale Funnel https://<node>.<tailnet>.ts.net
   --> 127.0.0.1:8443  this plugin: TLS + password + TOTP
   --> 127.0.0.1:3080  DSH web server
```

> **For a DSH agent deploying this:** follow [Deploy](#deploy) top to bottom. Steps marked **(human)** need a person (browser sign-in, admin console, choosing a password). Do not invent or store the password yourself; never print it back. Each step lists a check that must pass before you continue.

## Deploy with DSH (copy-paste prompt)

Paste this into a DSH session on the target machine. The agent follows the [Deploy](#deploy) steps below and stops for the parts only you can do.

````text
Deploy the dsh-remote-access plugin on this machine so I can open DSH from outside my LAN.

Source of truth: the deployment guide at
https://raw.githubusercontent.com/jitsmaster/dsh-plugins/main/dsh-remote-access/README.md
Fetch it first and follow its "Deploy" section step by step (steps 1 to 7).

Rules:
- Do each step in order. After each step, run its "Check" and show me the real output. Do not continue until the check passes. If a check fails, use the guide's Troubleshooting section and tell me what you found.
- Steps marked (human) need me: Tailscale sign-in/approval (step 2), the admin console changes (step 3) and choosing the password (step 4). For those, give me the exact action and wait. After I confirm, run the check.
- Never choose, generate, store, print or log my password or authenticator secret. I run setup.js myself, and you only check that auth.json exists.
- Read the public DNS name from `tailscale status --json` (Self.DNSName without the trailing dot) and use it for `hostnames` in the profile config. Do not guess it.
- If Tailscale is already installed and signed in, skip step 1 and the sign-in in step 2. Check with `tailscale status` first.
- If a `nodeAttrs` block already exists in my Tailscale policy, tell me to merge into it rather than replace it.
- Install with the `github:jitsmaster/dsh-plugins#path:/dsh-remote-access` spec, not a link. Use profile `web` unless I name another. Append to ~/.dsh/profiles/web/cordis.patch.yml and keep its existing entries.
- Before restarting DSH (step 7), tell me it will end active sessions and ask me to confirm. After the restart, run the step 7 checks.
- Test with the `curl --resolve` method in the guide, not through this machine's own tailnet address. Say clearly what you could not verify. I will confirm the browser login from my phone on mobile data.
- Do not change anything in the plugin's source code.

When done, report a short summary: the public URL, each check's result, and anything left for me to do.
````

## What it does and does not do

- DSH itself stays on loopback. The plugin's proxy is the only thing Funnel publishes, and its upstream is fixed to `127.0.0.1:3080`.
- Disabled by default and fails closed: nothing starts until a password exists.
- scrypt password, optional TOTP, per-IP lockout with a global failure budget, `__Host-` `HttpOnly` `Secure` `SameSite=Strict` session cookie (12 h).
- The proxy rewrites `Host`/`Origin` to loopback (so DSH's own trust check still applies), adds DSH's launch token to the index request itself (users never type it) and never forwards its session cookie to DSH.
- Treat the login as remote-code-execution access to the machine: use a long passphrase (14+ characters enforced) and TOTP. The URL is public and visible in Certificate Transparency logs, so expect probing.

## Requirements

- Windows with DSH running as `dsh web`, Node 22+, `pnpm`. Profile name below is `web`; substitute yours.
- A Tailscale account (free personal plan is enough) with admin rights on the tailnet.

## Deploy

### 1. Install Tailscale on the machine

```powershell
winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
```

(No winget: download the MSI from https://tailscale.com/download/windows and run it.) Installing needs admin rights (UAC). Endpoint security (e.g. Sophos Application Control) can be managed by policy, so if the install or service is blocked, ask IT to allow Tailscale.

**Check:** `& "C:\Program Files\Tailscale\tailscale.exe" version` prints a version, and `Get-Service Tailscale` is `Running`.

### 2. Add the machine to your tailnet **(human)**

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" login
```

This prints a URL and opens the browser. Sign in with the account that owns the tailnet and approve the device. (Alternatively click the Tailscale tray icon, then *Log in*.) Optionally give the machine a clear name in the admin console under *Machines*; the machine name is part of the public URL.

**Check:**

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" status
```

lists this machine with a `100.x.y.z` address, and `tailscale status --json` has `Self.Online = true`. Record the public name for later: `(tailscale status --json | ConvertFrom-Json).Self.DNSName` (strip the trailing dot), e.g. `awang-lpt2.taile1279d.ts.net`.

### 3. Enable HTTPS and Funnel in the admin console **(human)**

Open https://login.tailscale.com/admin and:

1. **DNS** page: turn on **HTTPS Certificates** (and acknowledge that machine names become public in Certificate Transparency logs).
2. **Access controls** page (policy file): allow Funnel for your devices by adding a `nodeAttrs` block, or merging into an existing one:

   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```

   Save. (This applies to every member's devices; narrow `target` to a tag or user if needed. A device is only public once Funnel is started on it.)

**Check:** `tailscale status --json` now shows the node under `CertDomains` and `Self.CapMap` containing `funnel`, `https` and `https://tailscale.com/cap/funnel-ports?ports=443,8443,10000`. If not, wait a minute and re-run.

### 4. Set the remote password **(human)**

```powershell
node <repo>\dsh-remote-access\setup.js --totp
```

It prompts for the password (minimum 14 characters), writes a scrypt hash and the TOTP secret to `~/.dsh/remote-access/auth.json`, and prints the secret/`otpauth://` link to add to an authenticator app. It must exist before the first start. Re-running changes the password live (no restart); without `--totp` it drops the TOTP requirement, with `--totp` it issues a new secret. Lost password or authenticator: delete `auth.json` and run it again.

**Check:** `Test-Path ~/.dsh/remote-access/auth.json` is `True`.

### 5. Install the plugin into the DSH profile

From a DSH source checkout:

```powershell
pnpm dsh plugin --profile web add "github:jitsmaster/dsh-plugins#path:/dsh-remote-access"
```

(Or, from a local clone for development: `... add "link:D:/path/to/dsh-plugins/dsh-remote-access"`.) This installs the package and lists `dsh-remote-access` in the profile's `bundles`.

**Check:** `~/.dsh/profiles/web/package.json` contains `dsh-remote-access` under both `dependencies` and `dsh.profile.bundles`.

### 6. Enable it in the profile config

Append to `~/.dsh/profiles/web/cordis.patch.yml` (the profile's config override file; keep existing entries), using the DNS name from step 2:

```yaml
# Remote access through Tailscale Funnel.
- id: remote-access
  config:
    enabled: true
    tailscale:
      funnel: true
      httpsPort: 443
    hostnames: [awang-lpt2.taile1279d.ts.net]
```

**Check:** `pnpm dsh --profile web --dump-config` shows the `remote-access` row with `enabled: true`.

### 7. Restart DSH, then verify

Restarting drops active DSH sessions, so do it at a good moment (a DSH agent should ask the user first). On start the plugin runs `tailscale funnel --bg --https=443 https+insecure://127.0.0.1:8443`.

**Checks:**

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" funnel status    # "Funnel on", / proxy https+insecure://127.0.0.1:8443
Get-Content ~/.dsh/remote-access/remote-access.log -Tail 10   # "proxy listening on https://127.0.0.1:8443"
```

From a device **not** on the LAN (phone on mobile data), open `https://<node>.<tailnet>.ts.net`, sign in with the password and the 6-digit code; DSH loads and the session lasts 12 hours. An unauthenticated request must return the login page (browsers) or `401` (API calls).

> Testing from the same machine: connections to the node's own tailnet address are answered locally and may hit another service on port 443 (this machine had IIS there). To test the real path, resolve the public address (`Resolve-DnsName <name> -Server 8.8.8.8`) and use `curl --resolve <name>:443:<public ip> https://<name>/`.

## Operate

| Task | How |
| --- | --- |
| Turn off | `enabled: false` in the profile config and restart, or `tailscale funnel --https=443 off` |
| Stale Funnel entry | `tailscale funnel reset` |
| Change password | re-run `setup.js` (live) |
| Update the plugin | repeat step 5 (re-resolves the branch), restart DSH |
| Logs | `~/.dsh/remote-access/remote-access.log` |

## Troubleshooting

- **`401 dsh web authentication required`** after login: the DSH launch token was not injected; look for `cannot get DSH launch token` in the log.
- **Plugin did not start**: log says `no password set`; run step 4. Or `enabled` is not `true` in the effective config.
- **`funnel` command errors**: Funnel or HTTPS is not enabled for this device (step 3); re-check `CapMap`.
- **Browser reports a certificate warning** on the Funnel URL: wait a minute after first enabling HTTPS certificates; the certificate is issued on demand.
- Not yet verified in a real browser: the live event stream and terminal panel through the proxy.

## Alternative tunnel: `ssh -R` to your own VPS (not needed with Tailscale)

Uses Windows' signed `ssh.exe` and a host you control; TLS ends on this machine with a self-signed certificate generated in pure Node (so the relay only sees ciphertext). Config:

```yaml
- id: remote-access
  config:
    enabled: true
    hostnames: [relay.example.com]
    tunnel:
      host: relay.example.com
      user: dshtunnel
      sshPort: 22
      identityFile: C:\Users\you\.ssh\dsh_tunnel_ed25519
      remotePort: 8443
      bindAddress: 0.0.0.0
```

On the relay create a key-only user (`dshtunnel`, shell `/usr/sbin/nologin`) with `Match User dshtunnel` / `GatewayPorts yes` / `AllowTcpForwarding remote` / `PermitTTY no` / `ForceCommand /bin/false`, open TCP 8443, add the public key to its `authorized_keys`, and trust the host key once with a manual `ssh` (the plugin uses `StrictHostKeyChecking=yes`). Browsers must accept the self-signed certificate once (**Advanced, then Proceed**); the plugin sends no HSTS so that option stays available. The certificate's SHA-256 fingerprint is logged at startup so you can compare it; import `~/.dsh/remote-access/tls/selfsigned.crt` into a device's trusted roots to remove the warning, or supply `tlsCert`/`tlsKey`.

## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch |
| `port` / `listenHost` | `8443` / `127.0.0.1` | Local proxy bind (keep loopback) |
| `targetHost` / `targetPort` | `127.0.0.1` / `3080` | The only upstream |
| `sessionHours` | `12` | Login session lifetime |
| `tailscale.funnel` / `httpsPort` | off / `443` | Publish via Tailscale Funnel (443, 8443 or 10000) |
| `tailscale.bin` | `C:\Program Files\Tailscale\tailscale.exe` | CLI path |
| `tunnel.*` | none | ssh -R variant (see above) |
| `hostnames` | none | Names/IPs for the generated self-signed cert (ssh variant) |
| `tlsCert` / `tlsKey` | generated | Your own certificate files |
