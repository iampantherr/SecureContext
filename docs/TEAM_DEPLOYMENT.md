# Team deployment — one stack, many developers

SecureContext runs 100% locally, and "locally" scales to a team: **one machine
hosts the stack, every teammate's Claude Code talks to it** over your LAN or
VPN with a personal, revocable key. Memory, programs, the audit chain, and the
dashboard become shared team infrastructure — still on hardware you own, still
no cloud.

```
   Dev A (Claude Code) ──┐
   Dev B (Claude Code) ──┼──►  Team host: Postgres + Ollama + sc-api (:3099)
   CI  (ci-memory CLI) ──┘      + operator dashboard + HMAC audit chain
```

## 1. Operator: bring up the team host

On the machine that will host the stack (a workstation, a home-lab box, an
office server):

```bash
git clone https://github.com/iampantherr/SecureContext ~/SecureContext
cd ~/SecureContext && node init.mjs        # full Docker stack
```

Then make the API reachable by teammates: ensure port `3099` is open on the
LAN/VPN interface. For anything beyond a trusted LAN, front it with TLS
(`docker/start.ps1 -Mode prod` includes an nginx reverse proxy) or a VPN like
Tailscale — the API is HTTP.

## 2. Operator: create a user + key per teammate

Every teammate gets their own `zck_…` key — sha256-stored, instantly revocable,
and every memory write they make carries their attribution.

```bash
KEY=$(grep ZC_API_KEY docker/.env | cut -d= -f2)   # operator master key
curl -s -X POST http://localhost:3099/api/v1/team/users \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"alice","display_name":"Alice"}'
curl -s -X POST http://localhost:3099/api/v1/team/keys \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"alice"}'
# → returns the zck_… key ONCE — send it to Alice over a secure channel
```

Revoke any key at any time with `POST /api/v1/team/keys/revoke`.

## 3. Teammate: join with one command

On each developer machine (Node 20+ and git; **no Docker needed**):

```bash
git clone https://github.com/iampantherr/SecureContext ~/SecureContext
cd ~/SecureContext && node init.mjs --join http://<team-host>:3099 zck_yourkey
```

This registers the MCP plugin against the team API, installs the harness hooks,
and verifies your key authenticates. Restart Claude Code and you're in.

## 4. Shared workspaces (optional)

Cross-project team memory lives in workspaces — virtual projects gated by
membership:

```bash
curl -s -X POST http://localhost:3099/api/v1/team/workspaces \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"slug":"platform-team","name":"Platform Team"}'
curl -s -X POST http://localhost:3099/api/v1/team/workspaces/members \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"slug":"platform-team","user_id":"alice"}'
```

Agents then read/write it as project `workspace:platform-team`.

## 5. What the team gets

- **Shared project memory** — decisions, gotchas, and program state persist
  across every member's sessions; `zc_program status` hands work between
  people's agents the same way it hands off between agents.
- **Attribution + audit** — every fact records who wrote it; every tool call is
  HMAC-chained per agent; session replay and the compliance report work across
  the whole team's activity.
- **One dashboard** — `http://<team-host>:3099/dashboard` shows live agent
  activity, delivery programs, token savings, and chain health for everyone.

## Security notes

- Keys are bearer credentials: treat `zck_…` like a password. Rotate by
  revoking + reissuing.
- The operator master key (`docker/.env` → `ZC_API_KEY`) can do everything —
  don't hand it to teammates; use per-user keys.
- Postgres RLS isolates per-agent memory namespaces; workspace membership is
  enforced per key.
- The machine secret never leaves the host — teammates cannot forge audit rows.
