# dsh-remote-access

Reach the DSH web app from any browser, with no public IP, no extra software and nothing else on the machine exposed.

```
browser --HTTPS--> your relay host --ssh -R tunnel--> 127.0.0.1:8443 (this plugin: TLS + login) --> 127.0.0.1:3080 (DSH)
```

## Why this should stay quiet under endpoint security (Sophos)
- Node built-ins only: no dependencies, no downloaded or bundled binaries, no installer or driver.
- The tunnel is Windows' own signed `ssh.exe`, making one outbound connection. No UPnP/SSDP, no port scanning, no firewall changes, no PowerShell or encoded commands.
- The proxy listens on loopback only. Nothing on the machine accepts inbound connections from the network.
- Caveat: a *network* Sophos Firewall may still classify outbound SSH to an unknown host. Use your own relay, and ask IT to allow that host/port if it is blocked. This cannot be verified without your Sophos policy.

## Security model
- Disabled by default; refuses to start until a password exists (fail closed).
- TLS ends on your machine, so the relay only sees ciphertext. Self-signed certificate is generated in pure Node (or supply `tlsCert`/`tlsKey`). Pin the fingerprint in your browser/device or use a real cert.
- scrypt password, optional TOTP, per-IP exponential lockout plus a global failure budget, `__Host-` HttpOnly Secure SameSite=Strict session cookie.
- Fixed upstream: only `127.0.0.1:3080`. Host/Origin are rewritten to loopback, so DSH's own DNS-rebinding fence still applies, and the session cookie is never forwarded to DSH.
- DSH can run commands, so treat this login as remote code execution access: long passphrase plus `--totp`.

## Setup
1. Password: `node dsh-remote-access/setup.js --totp` (add the printed secret to an authenticator).
2. Relay host (your VPS): create a user with a key-only login, e.g. `dshtunnel`, shell `/usr/sbin/nologin`. In `sshd_config`:
   ```
   Match User dshtunnel
       GatewayPorts yes
       AllowTcpForwarding remote
       PermitTTY no
       ForceCommand /bin/false
   ```
   Open TCP 8443 in the VPS firewall. Use a dedicated key: `ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\dsh_tunnel_ed25519`, and append the `.pub` to the user's `authorized_keys`.
3. Trust the relay once: `ssh -p 22 dshtunnel@relay.example.com` (accept the host key; the plugin uses `StrictHostKeyChecking=yes`).
4. Install: `dsh plugin --profile web add "github:jitsmaster/dsh-plugins#path:/dsh-remote-access"`, then put the `enabled: true`, `hostnames` and `tunnel:` values from [cordis.patch.yml](cordis.patch.yml) into your profile config.
5. Restart DSH, then open `https://relay.example.com:8443`.

Log: `~/.dsh/remote-access/remote-access.log`.

## Using the private (self-signed) certificate
The browser shows a warning the first time; click **Advanced, then Proceed** (Chrome/Edge: "Advanced" > "Continue to ...") and it works. The plugin deliberately sends **no HSTS header**, because HSTS would remove that "Proceed" option.
- Verify you reached your own machine: compare the certificate's SHA-256 fingerprint with the one logged at startup in `~/.dsh/remote-access/remote-access.log`.
- Put your relay's DNS name or IP in `hostnames` so the certificate matches. A mismatch is still bypassable but is a warning sign.
- To remove the warning entirely, import `~/.dsh/remote-access/tls/selfsigned.crt` into each device's trusted root store, or supply a real certificate via `tlsCert`/`tlsKey`.
- While the certificate is untrusted, browsers disable some secure-context features (service workers, possibly clipboard access). DSH should work, but a trusted certificate avoids this.
