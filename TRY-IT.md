# Try Ledgerhand: a step-by-step walkthrough

Ledgerhand is an agent for small business owners. It watches your cash, and when you are about to run short it suggests fixes. You approve one, it carries it out inside limits you set, and a separate checker confirms it did what was promised.

Everything here is practice data: a made-up company, a fake bank, simulated customers and suppliers. No real money moves and no real credentials are used.

This guide takes about 15 minutes: roughly 5 to set up, 10 to click through.

---

## Part 1: Set it up (once)

**You need:** [Docker Desktop](https://www.docker.com/products/docker-desktop/), [Bun](https://bun.sh) 1.3 or newer, and Node.js 20 or newer.

1. **Start Docker Desktop** and wait until it says it is running. The database runs in Docker, and nothing works without it.
2. Open a terminal in the project folder and run these one at a time:

```bash
bun install
bun run db:up                     # starts the PostgreSQL database in Docker
bun run db:migrate                # creates the tables
bun run db:seed                   # adds the made-up company, Mercer & Vale Packaging Ltd
bun run auth:seed                 # creates the demo logins
bun run mandate:v2                # signs the demo owner limits
bun run demo                      # starts the app on http://localhost:3000
```

3. Leave that last terminal running. Open **http://localhost:3000** in your browser.

- open Docker Desktop, run `bun run db:up`, then `bun run demo`.

---

## Part 2: The walkthrough

The green bar at the top of every screen, **Your next step**, always says what to do next. If you get lost, follow it.

### Step 1: Sign in
- Email: `owner@mercer-vale.example`
- Password: `Ledger-Owner-2026`

You land on **Today**: your balance and a 20-week cash chart. Right now it looks healthy.

### Step 2: Start a clean run
Click **Start a fresh demo** (top right). It makes a fresh copy of the practice business, so earlier clicks don't get in the way. It takes you to **Orders & quotes**.

### Step 3: Add the paperwork
1. Click **Add both sample documents**: a customer order from Northgate and a supplier quote from Kestrel.
2. Wait for "Both documents were read".
3. Open the first document, tick the checkbox if one is shown, and click **Confirm: use this commitment**.
4. Do the same for the second one.

Confirming means "yes, those numbers are right". The system reads the document and checks every figure against the text, but nothing counts until you confirm it. Text inside a document can never act as an instruction.

### Step 4: See the problem
Click **Today**. A red box says **Heads up: you would run out of cash**. **What is causing the gap** lists the reasons, for example the supplier's balance payment and a customer paying late. The chart dips below zero around week 5. All of these numbers come from fixed code, not from the AI.

Click **See the options**.

### Step 5: Pick a fix
You are on **Decisions**. The banner at the top says what is going on.

- **Your options** compares doing nothing (lowest balance about -£61k) with the agent's plans (balance stays positive).
- Click **Review and sign** on a plan. Try plan 3 first, to see what happens when someone says no.
- Enter your password `Ledger-Owner-2026`. If it asks for a second confirmation, use the second approver's password `Ledger-Approver-2026`.
- Click **Sign and authorise**.

Signing is what gives the agent permission, and only for that plan and inside your limits.

### Step 6: Let it act
Click **Run the plan**. The agent contacts the simulated supplier, customer and lender.

- If someone refuses, the banner says **Someone said no**. Click **Ask the agent to re-plan**. It tries again with new options that avoid what was refused. Sign one the same way and click **Run the plan** again.
- When it works you see **Fixed, and checked**, plus an **Independent check** card. The card compares what was promised, what was agreed and what the sandbox actually holds, and they all match.

### Step 7: Look around
- **Results**: doing nothing against what the plan achieved.
- **Your limits**: the rules you signed. Under **Try to break it**, click **Try it** on each attempt. The system tries to overspend or break a rule, and it is blocked every time. The limits are enforced by code, not by the AI.
- **Proof**: a tamper-evident record of everything that happened. Click **Verify the chain now** to confirm nothing was altered. On a case, you can also export a self-verifying HTML file.

---
