# PixelClawDashboard Agent Notes

## Runtime Topology

- Production dashboard는 launchd job `com.pixelclaw.dashboard`로 운영한다.
- Production은 `~/.local/share/pixel-claw-dashboard/current`에서 실행되며 `8791` 포트를 사용한다.
- Production DB 경로는 `~/.local/state/pixel-claw-dashboard/prod/pixel-claw-dashboard.sqlite`다.
- Preview dashboard는 launchd job `com.pixelclaw.dashboard.preview`로 운영한다.
- Preview는 repo working tree `/Users/itismyfield/PixelClawDashboard`에서 실행되며 `8792` 포트를 사용한다.
- Preview DB 경로는 `~/.local/state/pixel-claw-dashboard/preview/pixel-claw-dashboard.sqlite`다.

## Safe Workflow

- 개발과 검증은 preview에서 먼저 진행한다.
- production 승격은 `./scripts/runtime/deploy-stable-release.sh`로만 수행한다.
- `8791`에서 지속 실행용 `npm run start` 또는 `node --import tsx server/server-main.ts`를 수동으로 띄우지 않는다. production port를 가로채면 launchd 복구가 깨진다.
- production 재시작은 `launchctl kickstart -k gui/$(id -u)/com.pixelclaw.dashboard`를 사용한다.
- preview 재시작은 `launchctl kickstart -k gui/$(id -u)/com.pixelclaw.dashboard.preview`를 사용한다.

## Operational Guardrails

- production 로그는 `~/.local/state/pixel-claw-dashboard/logs/prod.out.log`, `~/.local/state/pixel-claw-dashboard/logs/prod.err.log`에서 확인한다.
- preview 로그는 `~/.local/state/pixel-claw-dashboard/logs/preview.out.log`, `~/.local/state/pixel-claw-dashboard/logs/preview.err.log`에서 확인한다.
- 현재는 별도 rescue bot이 없다. preview나 repo 변경이 production `8791` 가용성에 영향을 주지 않도록 stable launchd 경로를 우선 보호한다.
- dependency는 아직 repo `node_modules`를 공유한다. code path는 분리되어도 dependency churn은 production에 영향을 줄 수 있으므로 주의한다.

## Git Commit Convention

- **1이슈 = 1커밋** — 이슈 작업 완료 시 해당 이슈 변경만 포함한 커밋을 생성한다.
- 커밋 메시지에 이슈 번호를 포함한다 (예: `fix: ... (#11)`).
- 여러 이슈를 하나의 커밋에 묶지 않는다.
- 작업 완료 보고 시점에 커밋이 이미 존재해야 한다.

## Project Memory Docs

- PCD 메모리 문서 canonical 경로는 `~/.claude/projects/-Users-itismyfield-PixelClawDashboard/memory/` 이다.
- 주요 문서: `MEMORY.md`, `architecture.md`, `server-api.md`, `frontend.md`, `operations.md`, `lessons.md`
- repo 내부에서 문서가 보이지 않으면 위 경로를 먼저 확인하고, 코드 변경 시 해당 문서도 함께 갱신한다.
- 2026-03-08 기준 별도 Obsidian mirror 경로는 확인되지 않았다.
