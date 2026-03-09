import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const router = Router();
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..", "..");

function resolveSpriteRoot(filename: string): { root: string; safeName: string } | null {
  const safeName = path.basename(filename);
  const candidateRoots = [
    path.join(process.cwd(), "public", "sprites"),
    path.join(process.cwd(), "dist", "sprites"),
    path.join(PROJECT_ROOT, "public", "sprites"),
    path.join(PROJECT_ROOT, "dist", "sprites"),
  ];

  for (const root of candidateRoots) {
    if (fs.existsSync(path.join(root, safeName))) {
      return { root, safeName };
    }
  }

  return null;
}

// Serve sprite images
router.get("/sprites/:filename", (req, res) => {
  const spriteLocation = resolveSpriteRoot(req.params.filename);
  if (!spriteLocation) {
    return res.status(404).json({ error: "not_found" });
  }
  res.sendFile(spriteLocation.safeName, {
    dotfiles: "allow",
    root: spriteLocation.root,
  });
});

export default router;
