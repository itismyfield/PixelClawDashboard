import { type Application, type Container, Graphics } from "pixi.js";
import { CEO_ZONE_H, HALLWAY_H, TILE } from "./model";
import { drawBandGradient } from "./drawing-core";
import { drawPlant } from "./drawing-furniture-a";

interface BuildCeoAndHallwayParams {
  app: Application;
  OFFICE_W: number;
  totalH: number;
  meetingRoomY?: number;
  breakRoomY: number;
  isDark: boolean;
}

export function buildCeoAndHallway({
  app,
  OFFICE_W,
  totalH,
  meetingRoomY,
  breakRoomY,
  isDark,
}: BuildCeoAndHallwayParams): void {
  const bg = new Graphics();
  const bgFill = isDark ? 0x0e0e1c : 0xf5f0e8;
  const bgGradFrom = isDark ? 0x121222 : 0xf8f4ec;
  const bgGradTo = isDark ? 0x0a0a18 : 0xf0ece4;
  const bgStrokeInner = isDark ? 0x2a2a48 : 0xd8cfc0;
  const bgStrokeOuter = isDark ? 0x222240 : 0xe0d8cc;
  const bgDotColor = isDark ? 0x2a2a48 : 0xd0c8b8;
  bg.roundRect(0, 0, OFFICE_W, totalH, 6).fill(bgFill);
  drawBandGradient(bg, 2, 2, OFFICE_W - 4, totalH - 4, bgGradFrom, bgGradTo, 14, 0.82);
  bg.roundRect(2, 2, OFFICE_W - 4, totalH - 4, 5).stroke({ width: 1.5, color: bgStrokeInner, alpha: 0.55 });
  bg.roundRect(0, 0, OFFICE_W, totalH, 6).stroke({ width: 3, color: bgStrokeOuter });
  for (let i = 0; i < 22; i++) {
    const sx = 12 + ((i * 97) % Math.max(24, OFFICE_W - 24));
    const sy = 12 + ((i * 131) % Math.max(24, totalH - 24));
    bg.circle(sx, sy, i % 3 === 0 ? 1.1 : 0.8).fill({ color: bgDotColor, alpha: i % 2 === 0 ? 0.12 : 0.08 });
  }
  app.stage.addChild(bg);

  const hallY = CEO_ZONE_H;
  const hallG = new Graphics();
  const hallBase = isDark ? 0x252535 : 0xe8dcc8;
  const hallTile1 = isDark ? 0x2d2d40 : 0xf0e4d0;
  const hallTile2 = isDark ? 0x1f1f30 : 0xe8dcc8;
  const hallDash = isDark ? 0x3a3858 : 0xc8b898;
  const hallTrim = isDark ? 0x3a3858 : 0xd4c4a8;
  const hallGlow = isDark ? 0x3355bb : 0xfff8e0;
  hallG.rect(4, hallY, OFFICE_W - 8, HALLWAY_H).fill(hallBase);
  drawBandGradient(hallG, 4, hallY, OFFICE_W - 8, HALLWAY_H, hallTile1, hallTile2, 5, 0.38);
  for (let dx = 4; dx < OFFICE_W - 4; dx += TILE * 2) {
    hallG.rect(dx, hallY, TILE * 2, HALLWAY_H).fill({ color: hallTile1, alpha: 0.5 });
    hallG.rect(dx + TILE * 2, hallY, TILE * 2, HALLWAY_H).fill({ color: hallTile2, alpha: 0.3 });
  }
  for (let dx = 20; dx < OFFICE_W - 20; dx += 16) {
    hallG.rect(dx, hallY + HALLWAY_H / 2, 6, 1).fill({ color: hallDash, alpha: 0.4 });
  }
  hallG.rect(4, hallY, OFFICE_W - 8, 1.5).fill({ color: hallTrim, alpha: 0.5 });
  hallG.rect(4, hallY + HALLWAY_H - 1.5, OFFICE_W - 8, 1.5).fill({ color: hallTrim, alpha: 0.5 });
  hallG
    .ellipse(OFFICE_W / 2, hallY + HALLWAY_H / 2 + 1, Math.max(120, OFFICE_W * 0.28), 6)
    .fill({ color: hallGlow, alpha: isDark ? 0.06 : 0.08 });

  // Hallway before meeting room (between departments and meeting room)
  if (meetingRoomY != null) {
    const hallMtgY = meetingRoomY - HALLWAY_H;
    hallG.rect(4, hallMtgY, OFFICE_W - 8, HALLWAY_H).fill(hallBase);
    drawBandGradient(hallG, 4, hallMtgY, OFFICE_W - 8, HALLWAY_H, hallTile1, hallTile2, 5, 0.38);
    for (let dx = 4; dx < OFFICE_W - 4; dx += TILE * 2) {
      hallG.rect(dx, hallMtgY, TILE * 2, HALLWAY_H).fill({ color: hallTile1, alpha: 0.5 });
      hallG.rect(dx + TILE * 2, hallMtgY, TILE * 2, HALLWAY_H).fill({ color: hallTile2, alpha: 0.3 });
    }
    for (let dx = 20; dx < OFFICE_W - 20; dx += 16) {
      hallG.rect(dx, hallMtgY + HALLWAY_H / 2, 6, 1).fill({ color: hallDash, alpha: 0.4 });
    }
    hallG.rect(4, hallMtgY, OFFICE_W - 8, 1.5).fill({ color: hallTrim, alpha: 0.5 });
    hallG.rect(4, hallMtgY + HALLWAY_H - 1.5, OFFICE_W - 8, 1.5).fill({ color: hallTrim, alpha: 0.5 });
    hallG
      .ellipse(OFFICE_W / 2, hallMtgY + HALLWAY_H / 2 + 1, Math.max(120, OFFICE_W * 0.28), 6)
      .fill({ color: hallGlow, alpha: isDark ? 0.06 : 0.08 });
  }

  // Hallway before break room
  const hall2Y = breakRoomY - HALLWAY_H;
  hallG.rect(4, hall2Y, OFFICE_W - 8, HALLWAY_H).fill(hallBase);
  drawBandGradient(hallG, 4, hall2Y, OFFICE_W - 8, HALLWAY_H, hallTile1, hallTile2, 5, 0.38);
  for (let dx = 4; dx < OFFICE_W - 4; dx += TILE * 2) {
    hallG.rect(dx, hall2Y, TILE * 2, HALLWAY_H).fill({ color: hallTile1, alpha: 0.5 });
    hallG.rect(dx + TILE * 2, hall2Y, TILE * 2, HALLWAY_H).fill({ color: hallTile2, alpha: 0.3 });
  }
  for (let dx = 20; dx < OFFICE_W - 20; dx += 16) {
    hallG.rect(dx, hall2Y + HALLWAY_H / 2, 6, 1).fill({ color: hallDash, alpha: 0.4 });
  }
  hallG.rect(4, hall2Y, OFFICE_W - 8, 1.5).fill({ color: hallTrim, alpha: 0.5 });
  hallG.rect(4, hall2Y + HALLWAY_H - 1.5, OFFICE_W - 8, 1.5).fill({ color: hallTrim, alpha: 0.5 });
  hallG
    .ellipse(OFFICE_W / 2, hall2Y + HALLWAY_H / 2 + 1, Math.max(120, OFFICE_W * 0.28), 6)
    .fill({ color: hallGlow, alpha: isDark ? 0.06 : 0.08 });

  app.stage.addChild(hallG);
  drawPlant(app.stage as Container, 30, hallY + HALLWAY_H - 6, 2);
  drawPlant(app.stage as Container, OFFICE_W - 30, hallY + HALLWAY_H - 6, 1);
}
