# PixelClawDashboard (PCD)

Agent dashboard with office visualization and Discord announce bot.

## Overview

PixelClawDashboard is a Node.js web application that provides:
- Real-time agent status dashboard with Pixi.js office visualization
- Discord announce bot for forwarding messages to agent channels
- SQLite-based persistent storage
- RESTful API with 60+ endpoints

## Tech Stack

- **Runtime**: Node.js 25+ with native `node:sqlite`
- **Frontend**: React + Vite + Pixi.js
- **Backend**: Express + TypeScript (tsx)
- **Database**: SQLite (via node:sqlite)
- **Bot**: Discord.js for announce bot

## Quick Start

```bash
# Clone
git clone https://github.com/itismyfield/PixelClawDashboard.git
cd PixelClawDashboard

# Install dependencies
pnpm install

# Create .env
cp .env.example .env
# Edit .env with your tokens

# Development
pnpm dev

# Production build
pnpm build
```

## Configuration

Create a `.env` file with:
```
DISCORD_ANNOUNCE_BOT_TOKEN=your_discord_bot_token
SESSION_AUTH_TOKEN=your_random_auth_token
```

## Ports

| Port | Purpose |
|------|---------|
| 8791 | Production server |
| 8792 | Preview/development |

## Deployment

See [rcc-pcd-bootstrap](https://github.com/itismyfield/rcc-pcd-bootstrap) for automated deployment.

## License

MIT License - see [LICENSE](LICENSE)
