# LanWealth AI — Desktop

Electron desktop app for LanWealth AI Chat.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your Supabase anon key:
```
SUPABASE_ANON_KEY=eyJ...
```
Get it from: https://supabase.com/dashboard/project/umpwmtciqxthmyzpymhu/settings/api-keys

## Development
```bash
npm run dev
```

## Build installers
```bash
npm run package:mac   # .dmg (arm64 + x64)
npm run package:win   # .exe (NSIS)
npm run package:linux # .AppImage
```
