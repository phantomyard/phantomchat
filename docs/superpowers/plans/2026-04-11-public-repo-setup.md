# Public GitHub Repo Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish nostra.chat on GitHub as single public repo under `nostra-chat` account, with CI/CD deploying to Cloudflare Pages + GitHub Pages + IPFS on every push.

**Architecture:** Single repo, single remote. Gitignore `.planning/`. Keep `docs/` and `CLAUDE.md` (non-sensitive). Orphan commit with `nostra-chat` identity (clean break from previous dev alias). CI/CD already configured in `.github/workflows/deploy.yml` — just needs secrets. After setup, this becomes the only repo (old private GitLab becomes archive).

**Tech Stack:** Git, SSH, GitHub Actions, Cloudflare Pages, Pinata (IPFS)

---

## File Map

**Modified in main repo:**
- `.gitignore` — add `.planning/` + `public/*.js`, `public/*.js.map`, `public/*.css` (build artifacts)
- `~/.ssh/config` — add `github-nostra` host alias

**Created:**
- `~/.ssh/nostra-chat` + `.pub` — SSH keypair
- `~/Repository/nostra-public/` — temporary clone for orphan commit (deleted after push)

---

### Task 1: SSH Key + GitHub Account Setup

**Files:**
- Create: `~/.ssh/nostra-chat`, `~/.ssh/nostra-chat.pub`
- Modify: `~/.ssh/config`

- [ ] **Step 1: Generate SSH key**

```bash
ssh-keygen -t ed25519 -C "nostra-chat@users.noreply.github.com" -f ~/.ssh/nostra-chat -N ""
```

- [ ] **Step 2: Create SSH config** (create `~/.ssh/config` if it doesn't exist)

```bash
cat >> ~/.ssh/config << 'EOF'

Host github-nostra
  HostName github.com
  User git
  IdentityFile ~/.ssh/nostra-chat
  IdentitiesOnly yes
EOF
```

- [ ] **Step 3: Copy public key and add to GitHub**

```bash
cat ~/.ssh/nostra-chat.pub
```

On GitHub (logged in as `nostra-chat`): **Settings → SSH and GPG keys → New SSH key** → paste → save.

- [ ] **Step 4: Enable email privacy on GitHub**

On GitHub: **Settings → Emails** → check **Keep my email address private** + **Block command line pushes that expose my email**.

- [ ] **Step 5: Test SSH connection**

```bash
ssh -T git@github-nostra
```

Expected: `Hi nostra-chat! You've successfully authenticated...`

---

### Task 2: Create GitHub Repo

- [ ] **Step 1: Create repo on GitHub**

On GitHub (logged in as `nostra-chat`): **New repository**
- Name: `nostra.chat`
- Description: `Decentralized messaging client built with Solid.js`
- **Public**
- Do NOT initialize (no README, no .gitignore, no license)

> **Note:** If `gh` CLI is authenticated with a different account, use the browser. Or re-authenticate: `gh auth login --hostname github.com --git-protocol ssh`

---

### Task 3: Prepare Codebase

**Files:**
- Modify: `/home/raider/Repository/nostra.chat/.gitignore`

- [ ] **Step 1: Add `.planning/` and build artifacts to `.gitignore`**

Append to `.gitignore`:

```bash
echo -e '\n# Internal planning files\n.planning/' >> .gitignore
```

Add build artifact patterns under "Build outputs" in `.gitignore`:
```
public/*.js
public/*.js.map
public/*.css
```

**ALREADY DONE** — `.gitignore` updated and build artifacts (197 files, ~29MB) removed from tracking.

- [ ] **Step 2: Remove `.planning/` from git tracking (keep files on disk)**

```bash
cd /home/raider/Repository/nostra.chat
git rm -r --cached .planning/
```

- [ ] **Step 3: Verify untracked but still on disk**

```bash
git status .planning/       # should show nothing (ignored)
ls .planning/PROJECT.md     # should still exist on disk
git ls-files public/*.js    # should return nothing (untracked)
ls public/*.js | head -3    # should still exist on disk
```

---

### Task 4: Create Orphan Commit + Push

- [ ] **Step 1: Clone into temporary directory**

```bash
git clone /home/raider/Repository/nostra.chat ~/Repository/nostra-public
cd ~/Repository/nostra-public
```

- [ ] **Step 2: Configure identity**

```bash
git config user.name "nostra-chat"
git config user.email "nostra-chat@users.noreply.github.com"
```

- [ ] **Step 3: Create orphan branch**

```bash
git checkout --orphan main-clean
git add -A
```

- [ ] **Step 4: Verify no `.planning/` leaked (should be gitignored)**

```bash
git diff --cached --name-only | grep "\.planning/" && echo "FAIL" || echo "OK: .planning excluded"
```

- [ ] **Step 5: Commit**

```bash
git commit -m "Initial public release

Nostra.chat — decentralized messaging client built with Solid.js and TypeScript.
P2P messaging via Nostr relays with NIP-17 gift-wrap encryption.

License: GPL-3.0"
```

- [ ] **Step 6: Verify author**

```bash
git log -1 --format="%an <%ae>"
```

Expected: `nostra-chat <nostra-chat@users.noreply.github.com>`

- [ ] **Step 7: Push to GitHub**

```bash
git remote set-url origin git@github-nostra:nostra-chat/nostra.chat.git
git push -u origin main-clean:main
```

- [ ] **Step 8: Verify on GitHub**

Open `https://github.com/nostra-chat/nostra.chat`. Check:
- Single commit by `nostra-chat`
- No `.planning/` visible
- `src/`, `public/`, `package.json`, `.github/workflows/deploy.yml` present

---

### Task 5: Configure CI/CD Secrets

- [ ] **Step 1: Create Cloudflare account and get credentials**

1. Create Cloudflare account (with nostra-chat email or whatever you prefer)
2. Dashboard → **Pages → Create project → Direct Upload** → name: `nostra-chat`
3. Dashboard → **My Profile → API Tokens → Create Token** → template "Edit Cloudflare Workers" → copy token
4. Dashboard → sidebar → copy **Account ID**

- [ ] **Step 2: Get Pinata JWT token**

1. Go to `app.pinata.cloud` → create account (free, no card needed)
2. **API Keys → New Key → Admin** → copy JWT

- [ ] **Step 3: Add secrets to GitHub**

On GitHub: **repo Settings → Secrets and variables → Actions → New repository secret**

Add these three:
- `CLOUDFLARE_API_TOKEN` — the Cloudflare token from Step 1
- `CLOUDFLARE_ACCOUNT_ID` — the Account ID from Step 1
- `PINATA_JWT_TOKEN` — the JWT from Step 2

- [ ] **Step 4: Enable GitHub Pages**

On GitHub: **repo Settings → Pages → Source: GitHub Actions**

---

### Task 6: Test CI/CD Pipeline

- [ ] **Step 1: Trigger a build**

Push a trivial change to trigger the workflow:

```bash
cd ~/Repository/nostra-public
echo "" >> README.md  # or any minor change
git add README.md
git commit -m "chore: trigger initial CI/CD"
git push origin main
```

- [ ] **Step 2: Monitor GitHub Actions**

On GitHub: **Actions → "Deploy Nostra.chat"** — wait for all 4 jobs to go green:
1. `build` — pnpm install + pnpm build
2. `deploy-cloudflare` — Cloudflare Pages
3. `deploy-github-pages` — GitHub Pages
4. `deploy-ipfs` — IPFS via Pinata

- [ ] **Step 3: Verify all 3 mirrors**

Open each URL and verify the app loads:
- **Cloudflare:** URL in the `deploy-cloudflare` job logs
- **GitHub Pages:** `https://nostra-chat.github.io/nostra.chat/`
- **IPFS:** CID in `deploy-ipfs` job logs → `https://ipfs.io/ipfs/<CID>/`

---

### Task 7: Switch Main Repo to GitHub

After everything is verified, switch the main development repo to push to GitHub.

- [ ] **Step 1: Update remote in main repo**

```bash
cd /home/raider/Repository/nostra.chat
git remote rename origin old-private
git remote add origin git@github-nostra:nostra-chat/nostra.chat.git
```

- [ ] **Step 2: Configure identity for this repo**

```bash
git config user.name "nostra-chat"
git config user.email "nostra-chat@users.noreply.github.com"
```

- [ ] **Step 3: Delete temporary clone**

```bash
rm -rf ~/Repository/nostra-public
```

- [ ] **Step 4: Verify setup**

```bash
git remote -v
```

Expected:
```
old-private  <old-gitlab-url> (fetch)
old-private  <old-gitlab-url> (push)
origin       git@github-nostra:nostra-chat/nostra.chat.git (fetch)
origin       git@github-nostra:nostra-chat/nostra.chat.git (push)
```

---

## Daily Workflow After Setup

```bash
# Work normally, commit with nostra-chat identity (auto from git config)
git add -A && git commit -m "feat: whatever"
git push origin main       # → GitHub (public, triggers CI/CD)
# git push old-private main  # → old private repo (optional archive)
```

No sync scripts, no dual-repo maintenance. One repo, one push, three deploy mirrors.
