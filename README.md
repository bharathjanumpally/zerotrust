# ZT-RL Prototype

A runnable prototype for **RL-driven autonomous security hardening** with a **Zero Trust gate** and a **digital twin** safety simulator.

## Services
- `control-plane` (Node.js + Express): ingest telemetry, compute state, call RL, call OPA, simulate, execute (sandbox), compute reward
- `rl-engine` (Python + FastAPI): epsilon-greedy contextual bandit
- `policy` (OPA/Rego): Zero Trust policy decisions (allow/deny + reason)
- `ui-dashboard` (React + Vite): timeline + decisions view
- `postgres`: stores telemetry, states, decisions, simulations, executions, rewards


## Quick start
Prereqs: Docker Desktop.

```bash
cd zt-rl-prototype
docker compose up --build
```

Open:
- UI: http://localhost:5173
- Control plane API: http://localhost:8080
- RL engine: http://localhost:8000/docs
- OPA: http://localhost:8181

## Demo flow
1. In the UI, click **Generate Sample Telemetry**
2. Click **Run Hardening Cycle**
3. Watch: telemetry → RL decision → OPA gate → digital twin sim → execution → reward

## Local development (optional)
Each service can also be run standalone; see each subfolder README.

## Git push
After you download this repo:
```bash
git init
git add .
git commit -m "Initial prototype"

git branch -M main
git remote add origin git@github.com:<your-username>/<your-repo>.git
git push -u origin main
```

